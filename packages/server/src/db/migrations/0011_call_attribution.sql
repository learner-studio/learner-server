-- Who the learner is on calls: one row, like learning_policy_settings, so the
-- web app edits what every ingest and re-attribution reads.
CREATE TABLE public.learning_call_identity (
  config_key text PRIMARY KEY CHECK (config_key = 'default'),
  names jsonb NOT NULL DEFAULT '[]'::jsonb,
  emails jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every call's provider-neutral speech, as received. call_transcripts (in the
-- habits DB) holds the attributed row; this holds what attribution is derived
-- from, so a changed identity or a person's choice re-derives the row and
-- regrades the learner's lines without the source resending.
CREATE TABLE public.learning_call_speech (
  session_id text PRIMARY KEY,
  source text NOT NULL,
  call_id uuid NOT NULL,
  client_id text NOT NULL,
  speech jsonb NOT NULL,
  -- A person's choice of the learner's speaker labels on this call; NULL means
  -- none was made and the rules decide. An empty array means "I did not speak".
  claimed_speakers jsonb,
  -- Set when another source already delivered this meeting: kept, never stored or graded.
  duplicate_of text,
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_call_speech_live ON public.learning_call_speech (received_at) WHERE duplicate_of IS NULL;
