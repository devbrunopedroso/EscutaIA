import { desktop } from "../api";

// Onde ver que está gravando (barra de menus / bandeja) e o que fazer se o ícone sumir.
export function RecordingHelp() {
  const os = desktop?.platform ?? (navigator.userAgent.includes("Mac") ? "darwin" : navigator.userAgent.includes("Win") ? "win32" : "linux");
  return (
    <div className="stack narrow help">
      <h2>Como saber que está gravando</h2>

      <section className="card stack">
        <h3>Na janela do EscutaIA</h3>
        <p>
          Durante a gravação, o topo mostra <span className="rec-live"><span className="rec-dot" /> Gravando 12:03</span> com o
          botão <strong>■ Parar</strong>, e uma faixa vermelha logo abaixo. Ao parar, aparece “Enviando…” e depois “Gravação
          enviada”. O app avisa por notificação quando a transcrição termina.
        </p>
      </section>

      {os === "darwin" && (
        <section className="card stack">
          <h3>Na barra de menus do Mac</h3>
          <p>
            Com o app aberto, o ícone do EscutaIA fica na <strong>barra de menus, no canto superior direito</strong>, perto do
            relógio. Gravando, ele fica <strong>vermelho com o tempo ao lado</strong> (ex.: 🔴 12:03).{" "}
            <strong>Clique nele → “■ Parar e enviar”</strong> para encerrar de qualquer lugar.
          </p>
          <p>
            O próprio macOS também mostra que algo está gravando: o <strong>ponto laranja</strong> (microfone em uso) e, na
            Central de Controle, quais apps estão usando o microfone e gravando o áudio do sistema.
          </p>
          <h4>Não vejo o ícone</h4>
          <ol className="steps">
            <li>
              <strong>O app precisa estar aberto.</strong> Fechar a janela não fecha o app, mas “Sair” no menu do ícone (ou ⌘Q) fecha.
            </li>
            <li>
              <strong>macOS 26 (Tahoe) ou mais novo:</strong> abra <em>Ajustes do Sistema → Barra de Menus</em> e, em{" "}
              <em>Permitir na Barra de Menus</em>, ative o <strong>EscutaIA</strong>.
            </li>
            <li>
              <strong>MacBook com “notch” (entalhe da câmera):</strong> se houver muitos ícones, os da esquerda ficam escondidos
              atrás do entalhe. Segure <kbd>⌘ Command</kbd> e arraste o ícone do EscutaIA para mais perto do relógio, ou feche
              outros apps da barra. O app gratuito <em>Ice</em> ajuda a organizar os ícones.
            </li>
          </ol>
          <h4>Permissões (só na 1ª gravação)</h4>
          <ul className="steps">
            <li>
              <strong>Áudio do sistema:</strong> o macOS pergunta se o EscutaIA pode gravar o áudio do sistema → <em>Permitir</em>.
              Se negou sem querer: <em>Ajustes do Sistema → Privacidade e Segurança → Gravação de Tela e Áudio do Sistema</em> →
              ative o EscutaIA e abra o app de novo.
            </li>
            <li>
              <strong>Microfone:</strong> <em>Privacidade e Segurança → Microfone</em> → ative o EscutaIA.
            </li>
          </ul>
        </section>
      )}

      {os === "win32" && (
        <section className="card stack">
          <h3>Na bandeja do Windows</h3>
          <p>
            O ícone do EscutaIA fica na <strong>bandeja, perto do relógio</strong>. Gravando, ele fica <strong>vermelho</strong>;
            passe o mouse para ver o tempo e clique com o botão direito → <strong>■ Parar e enviar</strong>.
          </p>
          <h4>Não vejo o ícone</h4>
          <ol className="steps">
            <li>Clique na setinha <strong>^</strong> ao lado do relógio: ícones escondidos ficam ali. Arraste o EscutaIA para a barra.</li>
            <li>
              Para deixá-lo sempre visível: <em>Configurações → Personalização → Barra de tarefas → Outros ícones da bandeja do
              sistema</em> → ative o <strong>EscutaIA</strong>.
            </li>
          </ol>
        </section>
      )}

      {os === "linux" && (
        <section className="card stack">
          <h3>Na bandeja do Linux</h3>
          <p>
            O ícone do EscutaIA fica na bandeja do sistema (fica vermelho ao gravar; clique para parar). No <strong>GNOME</strong>
            (Ubuntu, Fedora), a bandeja precisa da extensão <em>AppIndicator and KStatusNotifierItem Support</em> (já vem no
            Ubuntu). KDE, Cinnamon e XFCE mostram a bandeja sem nada a instalar.
          </p>
        </section>
      )}

      <section className="card stack">
        <h3>Gravando pelo navegador (extensão)</h3>
        <p>
          A extensão mostra <strong>REC</strong> em vermelho no ícone dela, na barra do Chrome. Clique no ícone →{" "}
          <strong>■ Parar e enviar</strong>. Ela também para sozinha quando você sai da reunião ou fecha a aba.
        </p>
      </section>
    </div>
  );
}
