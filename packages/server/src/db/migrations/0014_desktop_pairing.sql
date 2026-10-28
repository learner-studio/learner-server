-- learner-desktop's own side of pairing (docs/specs/server-desktop-pairing.md):
-- the API URL it uses, the endpointsVersion it holds and its local services,
-- as of its latest heartbeat that carried a report.
ALTER TABLE public.learner_desktop_devices
    ADD COLUMN pairing jsonb,
    ADD COLUMN pairing_reported_at timestamptz;
