'use client';

import { useEffect, useState } from 'react';
import { conectarWhatsapp } from '../app/acoes';

/**
 * O botão que abre o fluxo oficial da Meta e entrega o código ao servidor.
 *
 * É o único componente de cliente desta tela, e faz só isto: o SDK da Meta roda
 * no navegador, e não há como abrir o fluxo do servidor. O que ele recebe é um
 * CÓDIGO — não um token. O código sozinho não vale nada: trocá-lo exige o
 * segredo do app, que só existe na nossa API.
 *
 * Nada é guardado no aparelho. Nem o código, nem o PIN, nem rascunho.
 */

interface RespostaDoSdk {
  authResponse?: { code?: string };
}

interface SdkDaMeta {
  init(config: { appId: string; cookie: boolean; xfbml: boolean; version: string }): void;
  login(
    retorno: (resposta: RespostaDoSdk) => void,
    opcoes: {
      config_id: string;
      response_type: string;
      override_default_response_type: boolean;
      extras: { featureType: string };
    },
  ): void;
}

declare global {
  interface Window {
    FB?: SdkDaMeta;
    fbAsyncInit?: () => void;
  }
}

const VERSAO = 'v21.0';
const SDK = 'https://connect.facebook.net/pt_BR/sdk.js';

export function ConectarWhatsapp({
  appId,
  configId,
  reconectar,
}: {
  appId: string;
  configId: string;
  reconectar: boolean;
}) {
  const [pin, setPin] = useState('');
  const [estado, setEstado] = useState<'parado' | 'trabalhando'>('parado');
  const [aviso, setAviso] = useState('');

  useEffect(() => {
    window.fbAsyncInit = () => {
      window.FB?.init({ appId, cookie: true, xfbml: true, version: VERSAO });
    };
    if (document.querySelector(`script[src="${SDK}"]`) !== null) return;
    const tag = document.createElement('script');
    tag.src = SDK;
    tag.async = true;
    tag.defer = true;
    tag.crossOrigin = 'anonymous';
    document.head.appendChild(tag);
  }, [appId]);

  /** Abre o fluxo da Meta. Resolve com o código, ou conta por que não deu. */
  function pedirCodigo(): Promise<string> {
    return new Promise((resolve, reject) => {
      const sdk = window.FB;
      if (sdk === undefined) {
        reject(new Error('A janela da Meta não carregou. Recarregue a página e tente de novo.'));
        return;
      }
      sdk.login(
        (resposta) => {
          const codigo = resposta.authResponse?.code;
          if (codigo === undefined || codigo === '') {
            reject(new Error('Você fechou a janela da Meta antes de terminar.'));
            return;
          }
          resolve(codigo);
        },
        {
          config_id: configId,
          response_type: 'code',
          override_default_response_type: true,
          // Coexistência: a clínica segue atendendo pelo app do celular.
          extras: { featureType: 'whatsapp_business_app_onboarding' },
        },
      );
    });
  }

  async function aoClicar(): Promise<void> {
    if (!/^\d{6}$/.test(pin.trim())) {
      setAviso('O PIN tem exatamente 6 dígitos.');
      return;
    }
    setAviso('');
    setEstado('trabalhando');
    try {
      const codigo = await pedirCodigo();
      const r = await conectarWhatsapp(codigo, pin.trim(), reconectar);
      setAviso(
        r.ok
          ? ''
          : 'Não consegui ligar o número. Confira o PIN de verificação em duas etapas e tente de novo.',
      );
      if (r.ok) setPin('');
    } catch (erro) {
      setAviso(erro instanceof Error ? erro.message : 'Não consegui abrir a janela da Meta.');
    } finally {
      setEstado('parado');
    }
  }

  return (
    <div>
      <label className="mb-1 block text-[13px] font-semibold" htmlFor="pin">
        PIN de 6 dígitos do número
      </label>
      <input
        id="pin"
        value={pin}
        inputMode="numeric"
        maxLength={6}
        autoComplete="off"
        placeholder="000000"
        onChange={(e) => {
          setPin(e.target.value);
        }}
        className="border-linha-forte bg-paper text-ink w-[140px] rounded-[6px] border px-3 py-2 tracking-[3px] tabular-nums"
      />
      <p className="text-ink-suave mt-2 mb-3 max-w-[46ch] text-[13px]">
        É o PIN de verificação em duas etapas do WhatsApp da clínica. Se você ainda não tem um,
        escolha um agora e guarde — vamos pedir de novo se o número precisar ser religado.
      </p>
      <button
        type="button"
        onClick={() => void aoClicar()}
        disabled={estado === 'trabalhando'}
        className="bg-petrol text-paper rounded-full px-4 py-2 font-semibold disabled:opacity-55"
      >
        {estado === 'trabalhando'
          ? 'Abrindo a janela da Meta…'
          : reconectar
            ? 'Religar o número'
            : 'Conectar WhatsApp'}
      </button>
      {aviso !== '' && (
        <p role="status" className="text-risk mt-3 max-w-[52ch] text-[13px]">
          {aviso}
        </p>
      )}
    </div>
  );
}
