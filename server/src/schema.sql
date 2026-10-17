CREATE EXTENSION IF NOT EXISTS unaccent;

-- Configuração de busca em português que ignora acentos: "reuniao" acha "reunião".
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = 'pt_unaccent') THEN
    CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
    ALTER TEXT SEARCH CONFIGURATION pt_unaccent
      ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  name          text,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS meetings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  title       text NOT NULL,
  source_url  text,
  platform    text,
  status      text NOT NULL DEFAULT 'queued'
              CHECK (status IN ('queued', 'transcribing', 'summarizing', 'ready', 'failed')),
  error       text,
  audio_path  text NOT NULL,
  duration_ms integer,
  summary     text,
  started_at  timestamptz,
  claimed_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  title_tsv   tsvector GENERATED ALWAYS AS (to_tsvector('pt_unaccent'::regconfig, title)) STORED
);

CREATE TABLE IF NOT EXISTS segments (
  id         bigserial PRIMARY KEY,
  meeting_id uuid NOT NULL REFERENCES meetings ON DELETE CASCADE,
  idx        integer NOT NULL,
  start_ms   integer NOT NULL,
  end_ms     integer NOT NULL,
  speaker    text,
  text       text NOT NULL,
  tsv        tsvector GENERATED ALWAYS AS (to_tsvector('pt_unaccent'::regconfig, text)) STORED
);

CREATE INDEX IF NOT EXISTS meetings_user_created ON meetings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS meetings_queued ON meetings (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS meetings_title_tsv ON meetings USING gin (title_tsv);
CREATE INDEX IF NOT EXISTS segments_meeting ON segments (meeting_id, idx);
CREATE INDEX IF NOT EXISTS segments_tsv ON segments USING gin (tsv);

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speakers jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Credenciais do Claude por usuário (tela Configurações → Claude), criptografadas.
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_kind text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_hint text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS claude_updated_at timestamptz;

-- Falha do resumo fica separada do texto do resumo, para o site oferecer "Gerar resumo".
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS summary_error text;
UPDATE meetings SET summary_error = regexp_replace(summary, '^_Não foi possível gerar o resumo: (.*)_$', '\1'), summary = NULL
WHERE summary LIKE '\_Não foi possível gerar o resumo:%';

-- Quem fala: número informado na tela, legendas do Meet/Teams e pedido de refazer.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speakers_others integer;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speaker_timeline jsonb;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS speakers_pending boolean NOT NULL DEFAULT false;

-- Modo local: extensões aprovadas pela pessoa numa janela do app (token salvo só como hash).
CREATE TABLE IF NOT EXISTS local_clients (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  token_hash   text UNIQUE NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);

-- Configurações do app (ex.: modelo do Whisper escolhido na tela).
CREATE TABLE IF NOT EXISTS app_settings (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

-- Quantas vezes o worker pegou a reunião. Se o processo cair no meio (ex.: modelo
-- corrompido derruba o onnxruntime), não fica em loop: na 3ª vez vira erro.
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
