-- Baseline for the learner database.
-- Generated 2026-10-21 from a schema-only dump of the learning_* tables, their trigger
-- functions and telemetry_outbox in the former host database (migrations 0143..0185 squashed).

CREATE OR REPLACE FUNCTION public.learning_archive_guard_chunk_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  current_status TEXT;
BEGIN
  SELECT manifest_status INTO current_status
    FROM learning_archive_versions
   WHERE version_id = CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  IF current_status = 'sealed'
     AND NOT (TG_OP = 'DELETE' AND EXISTS (
       SELECT 1 FROM learning_cli_vector_e2e_runs fixture
        WHERE OLD.version_id = ANY(fixture.version_ids)
          AND fixture.status <> 'cleaned'
     )) THEN
    RAISE EXCEPTION 'chunks of a sealed learning archive version are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.learning_archive_guard_version_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.manifest_status = 'sealed'
     AND NOT EXISTS (
       SELECT 1 FROM learning_cli_vector_e2e_runs fixture
        WHERE fixture.source_id = OLD.source_id
          AND OLD.version_id = ANY(fixture.version_ids)
          AND fixture.status <> 'cleaned'
     ) THEN
    RAISE EXCEPTION 'sealed learning archive versions are immutable';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.manifest_status = 'sealed' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'sealed learning archive versions are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.learning_archive_reject_blob_mutation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
     AND NOT EXISTS (SELECT 1 FROM learning_archive_version_chunks chunk WHERE chunk.blob_sha256 = OLD.sha256)
     AND EXISTS (
       SELECT 1 FROM learning_cli_vector_e2e_runs fixture
        WHERE encode(OLD.sha256, 'hex') = ANY(fixture.blob_sha256)
          AND fixture.status <> 'cleaned'
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'learning archive blobs are immutable';
END;
$function$
;
CREATE OR REPLACE FUNCTION public.learning_archive_validate_version_seal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  chunk_count BIGINT;
  ordinal_min INTEGER;
  ordinal_max INTEGER;
  length_sum BIGINT;
  first_offset BIGINT;
  final_offset BIGINT;
  discontinuities BIGINT;
BEGIN
  IF NEW.manifest_status <> 'sealed' OR OLD.manifest_status = 'sealed' THEN
    RETURN NEW;
  END IF;

  SELECT COUNT(*), MIN(chunk_ordinal), MAX(chunk_ordinal), COALESCE(SUM(raw_byte_length), 0),
         MIN(byte_offset), MAX(byte_offset + raw_byte_length)
    INTO chunk_count, ordinal_min, ordinal_max, length_sum, first_offset, final_offset
    FROM learning_archive_version_chunks
   WHERE version_id = NEW.version_id;

  SELECT COUNT(*) INTO discontinuities
    FROM (
      SELECT byte_offset,
             LAG(byte_offset + raw_byte_length) OVER (ORDER BY chunk_ordinal) AS prior_end
        FROM learning_archive_version_chunks
       WHERE version_id = NEW.version_id
    ) ordered_chunks
   WHERE prior_end IS NOT NULL AND byte_offset <> prior_end;

  IF (NEW.captured_byte_length = 0 AND chunk_count <> 0)
     OR (NEW.captured_byte_length > 0 AND (
       chunk_count = 0 OR ordinal_min <> 0 OR ordinal_max <> chunk_count - 1
       OR length_sum <> NEW.captured_byte_length OR first_offset <> NEW.byte_offset
       OR final_offset <> NEW.byte_offset + NEW.captured_byte_length OR discontinuities <> 0
     )) THEN
    RAISE EXCEPTION 'cannot seal non-contiguous learning archive version %', NEW.version_id;
  END IF;
  RETURN NEW;
END;
$function$
;
CREATE OR REPLACE FUNCTION public.learning_assessment_immutable()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN RAISE EXCEPTION 'Learning assessment evidence and receipts are immutable'; END $function$
;
CREATE OR REPLACE FUNCTION public.learning_record_vector_arrival()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.current_canonical AND NEW.status='indexed' THEN
      INSERT INTO learning_vector_arrivals(message_id) VALUES(NEW.message_id);
    END IF;
  ELSIF NEW.current_canonical AND NEW.status='indexed'
    AND (NOT OLD.current_canonical OR OLD.status IS DISTINCT FROM NEW.status) THEN
    INSERT INTO learning_vector_arrivals(message_id) VALUES(NEW.message_id);
  END IF;
  RETURN NEW;
END $function$
;



CREATE TABLE public.learning_active_archive_notifications (
    invocation_id uuid NOT NULL,
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_active_archive_sessions (
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    requested_generation bigint DEFAULT 0 NOT NULL,
    captured_generation bigint DEFAULT 0 NOT NULL,
    dispatch_id uuid,
    run_id uuid,
    active_slot integer,
    attempts integer DEFAULT 0 NOT NULL,
    last_notified_at timestamp with time zone DEFAULT now() NOT NULL,
    last_finished_at timestamp with time zone,
    last_run_id uuid,
    last_failure text,
    CONSTRAINT learning_active_archive_sessions_active_slot_check CHECK (((active_slot >= 1) AND (active_slot <= 3))),
    CONSTRAINT learning_active_archive_sessions_attempts_check CHECK (((attempts >= 0) AND (attempts <= 3))),
    CONSTRAINT learning_active_archive_sessions_check CHECK ((captured_generation <= requested_generation))
);

CREATE TABLE public.learning_archive_blobs (
    sha256 bytea NOT NULL,
    raw_byte_length integer NOT NULL,
    codec text NOT NULL,
    codec_version text NOT NULL,
    encoded_bytes bytea NOT NULL,
    encoded_byte_length integer NOT NULL,
    encoded_sha256 bytea NOT NULL,
    verified_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_blobs_check CHECK ((octet_length(encoded_bytes) = encoded_byte_length)),
    CONSTRAINT learning_archive_blobs_codec_check CHECK ((codec = 'gzip'::text)),
    CONSTRAINT learning_archive_blobs_encoded_byte_length_check CHECK ((encoded_byte_length >= 0)),
    CONSTRAINT learning_archive_blobs_encoded_sha256_check CHECK ((octet_length(encoded_sha256) = 32)),
    CONSTRAINT learning_archive_blobs_raw_byte_length_check CHECK (((raw_byte_length >= 0) AND (raw_byte_length <= 4194304))),
    CONSTRAINT learning_archive_blobs_sha256_check CHECK ((octet_length(sha256) = 32))
);

CREATE TABLE public.learning_archive_checkpoints (
    source_id uuid NOT NULL,
    generation integer NOT NULL,
    cursor_offset bigint DEFAULT 0 NOT NULL,
    last_version_number bigint DEFAULT 0 NOT NULL,
    last_verified_version_id uuid,
    recovery_state text DEFAULT 'ready'::text NOT NULL,
    last_success_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_checkpoints_cursor_offset_check CHECK ((cursor_offset >= 0)),
    CONSTRAINT learning_archive_checkpoints_generation_check CHECK ((generation >= 0)),
    CONSTRAINT learning_archive_checkpoints_last_version_number_check CHECK ((last_version_number >= 0)),
    CONSTRAINT learning_archive_checkpoints_recovery_state_check CHECK ((recovery_state = ANY (ARRAY['ready'::text, 'capturing'::text, 'retryable_error'::text, 'terminal_gap'::text])))
);

CREATE TABLE public.learning_archive_errors (
    error_id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid,
    source_id uuid,
    generation integer,
    version_id uuid,
    error_code text NOT NULL,
    error_message text NOT NULL,
    retryable boolean NOT NULL,
    is_gap boolean DEFAULT false NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_errors_generation_check CHECK (((generation IS NULL) OR (generation >= 0)))
);

CREATE TABLE public.learning_archive_runs (
    run_id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_kind text NOT NULL,
    status text DEFAULT 'running'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    sources_discovered integer DEFAULT 0 NOT NULL,
    sources_captured integer DEFAULT 0 NOT NULL,
    versions_sealed integer DEFAULT 0 NOT NULL,
    gaps_recorded integer DEFAULT 0 NOT NULL,
    errors_recorded integer DEFAULT 0 NOT NULL,
    bytes_read bigint DEFAULT 0 NOT NULL,
    raw_bytes_stored bigint DEFAULT 0 NOT NULL,
    encoded_bytes_stored bigint DEFAULT 0 NOT NULL,
    deduplicated_bytes bigint DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary text,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_runs_bytes_read_check CHECK ((bytes_read >= 0)),
    CONSTRAINT learning_archive_runs_check CHECK ((((status = 'running'::text) AND (completed_at IS NULL)) OR ((status <> 'running'::text) AND (completed_at IS NOT NULL)))),
    CONSTRAINT learning_archive_runs_deduplicated_bytes_check CHECK ((deduplicated_bytes >= 0)),
    CONSTRAINT learning_archive_runs_encoded_bytes_stored_check CHECK ((encoded_bytes_stored >= 0)),
    CONSTRAINT learning_archive_runs_errors_recorded_check CHECK ((errors_recorded >= 0)),
    CONSTRAINT learning_archive_runs_gaps_recorded_check CHECK ((gaps_recorded >= 0)),
    CONSTRAINT learning_archive_runs_raw_bytes_stored_check CHECK ((raw_bytes_stored >= 0)),
    CONSTRAINT learning_archive_runs_run_kind_check CHECK ((run_kind = ANY (ARRAY['scheduled'::text, 'backfill'::text, 'recovery'::text, 'probe'::text, 'e2e'::text]))),
    CONSTRAINT learning_archive_runs_sources_captured_check CHECK ((sources_captured >= 0)),
    CONSTRAINT learning_archive_runs_sources_discovered_check CHECK ((sources_discovered >= 0)),
    CONSTRAINT learning_archive_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'partial'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT learning_archive_runs_versions_sealed_check CHECK ((versions_sealed >= 0))
);

CREATE TABLE public.learning_archive_sources (
    source_id uuid DEFAULT gen_random_uuid() NOT NULL,
    host text NOT NULL,
    provider text NOT NULL,
    root_path text NOT NULL,
    relative_path text NOT NULL,
    file_kind text NOT NULL,
    device_id bigint,
    inode_id bigint,
    generation integer DEFAULT 0 NOT NULL,
    generation_reason text DEFAULT 'first-observation'::text NOT NULL,
    discovery_state text DEFAULT 'discovered'::text NOT NULL,
    source_mtime_ns numeric(30,0),
    source_ctime_ns numeric(30,0),
    source_size bigint,
    first_observed_at timestamp with time zone NOT NULL,
    last_observed_at timestamp with time zone NOT NULL,
    last_success_at timestamp with time zone,
    last_error_at timestamp with time zone,
    last_error_code text,
    last_error_message text,
    lease_owner uuid,
    lease_token uuid,
    lease_expires_at timestamp with time zone,
    fencing_token bigint DEFAULT 0 NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_sources_check CHECK ((((lease_owner IS NULL) AND (lease_token IS NULL) AND (lease_expires_at IS NULL)) OR ((lease_owner IS NOT NULL) AND (lease_token IS NOT NULL) AND (lease_expires_at IS NOT NULL)))),
    CONSTRAINT learning_archive_sources_discovery_state_check CHECK ((discovery_state = ANY (ARRAY['discovered'::text, 'capturing'::text, 'current'::text, 'missing'::text, 'unreadable'::text, 'out_of_scope'::text, 'error'::text]))),
    CONSTRAINT learning_archive_sources_fencing_token_check CHECK ((fencing_token >= 0)),
    CONSTRAINT learning_archive_sources_generation_check CHECK ((generation >= 0)),
    CONSTRAINT learning_archive_sources_relative_path_check CHECK (((relative_path <> ''::text) AND (relative_path !~ '(^|/)\.\.(/|$)'::text))),
    CONSTRAINT learning_archive_sources_source_size_check CHECK (((source_size IS NULL) OR (source_size >= 0)))
);

CREATE TABLE public.learning_archive_version_chunks (
    version_id uuid NOT NULL,
    chunk_ordinal integer NOT NULL,
    byte_offset bigint NOT NULL,
    raw_byte_length integer NOT NULL,
    blob_sha256 bytea NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_version_chunks_byte_offset_check CHECK ((byte_offset >= 0)),
    CONSTRAINT learning_archive_version_chunks_chunk_ordinal_check CHECK ((chunk_ordinal >= 0)),
    CONSTRAINT learning_archive_version_chunks_raw_byte_length_check CHECK (((raw_byte_length > 0) AND (raw_byte_length <= 4194304)))
);

CREATE TABLE public.learning_archive_versions (
    version_id uuid DEFAULT gen_random_uuid() NOT NULL,
    capture_key text NOT NULL,
    source_id uuid NOT NULL,
    run_id uuid,
    base_version_id uuid,
    generation integer NOT NULL,
    version_number bigint NOT NULL,
    capture_kind text NOT NULL,
    consistency_status text NOT NULL,
    coverage_status text NOT NULL,
    byte_offset bigint NOT NULL,
    captured_byte_length bigint NOT NULL,
    aggregate_sha256 bytea NOT NULL,
    observed_device_id bigint,
    observed_inode_id bigint,
    observed_mode integer,
    observed_size bigint,
    observed_mtime_ns numeric(30,0),
    observed_ctime_ns numeric(30,0),
    capture_started_at timestamp with time zone NOT NULL,
    capture_ended_at timestamp with time zone NOT NULL,
    limitations jsonb DEFAULT '[]'::jsonb NOT NULL,
    manifest_status text DEFAULT 'writing'::text NOT NULL,
    sealed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_archive_versions_aggregate_sha256_check CHECK ((octet_length(aggregate_sha256) = 32)),
    CONSTRAINT learning_archive_versions_byte_offset_check CHECK ((byte_offset >= 0)),
    CONSTRAINT learning_archive_versions_capture_key_check CHECK ((capture_key ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT learning_archive_versions_capture_kind_check CHECK ((capture_kind = ANY (ARRAY['append-prefix'::text, 'complete-file'::text, 'consistent-sqlite-snapshot'::text]))),
    CONSTRAINT learning_archive_versions_captured_byte_length_check CHECK ((captured_byte_length >= 0)),
    CONSTRAINT learning_archive_versions_check CHECK ((capture_ended_at >= capture_started_at)),
    CONSTRAINT learning_archive_versions_check1 CHECK ((((manifest_status = 'writing'::text) AND (sealed_at IS NULL)) OR ((manifest_status = 'sealed'::text) AND (sealed_at IS NOT NULL)))),
    CONSTRAINT learning_archive_versions_check2 CHECK (((base_version_id IS NULL) OR (base_version_id <> version_id))),
    CONSTRAINT learning_archive_versions_consistency_status_check CHECK ((consistency_status = ANY (ARRAY['stable-prefix'::text, 'stable-file'::text, 'logical-sqlite-snapshot'::text, 'ambiguous'::text, 'failed'::text]))),
    CONSTRAINT learning_archive_versions_coverage_status_check CHECK ((coverage_status = ANY (ARRAY['prefix'::text, 'complete'::text, 'gap'::text]))),
    CONSTRAINT learning_archive_versions_generation_check CHECK ((generation >= 0)),
    CONSTRAINT learning_archive_versions_manifest_status_check CHECK ((manifest_status = ANY (ARRAY['writing'::text, 'sealed'::text]))),
    CONSTRAINT learning_archive_versions_observed_size_check CHECK (((observed_size IS NULL) OR (observed_size >= 0))),
    CONSTRAINT learning_archive_versions_version_number_check CHECK ((version_number > 0))
);

CREATE TABLE public.learning_cli_vector_e2e_runs (
    run_id uuid NOT NULL,
    workflow_run_id uuid,
    provider text NOT NULL,
    model text NOT NULL,
    session_id uuid NOT NULL,
    marker_sha256 text NOT NULL,
    prompt_sha256 text NOT NULL,
    reply_sha256 text,
    prompt_bytes integer NOT NULL,
    reply_bytes integer,
    source_path text NOT NULL,
    source_device bigint,
    source_inode bigint,
    source_id uuid,
    archive_run_id uuid,
    version_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    observation_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    message_ids text[] DEFAULT '{}'::text[] NOT NULL,
    chunk_ids text[] DEFAULT '{}'::text[] NOT NULL,
    operation_ids uuid[] DEFAULT '{}'::uuid[] NOT NULL,
    blob_sha256 text[] DEFAULT '{}'::text[] NOT NULL,
    call_attempts integer DEFAULT 0 NOT NULL,
    mastery_excluded boolean DEFAULT true NOT NULL,
    status text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    cli_completed_at timestamp with time zone,
    archived_at timestamp with time zone,
    indexed_at timestamp with time zone,
    cleaned_at timestamp with time zone,
    timings jsonb DEFAULT '{}'::jsonb NOT NULL,
    cleanup_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_cli_vector_e2e_runs_call_attempts_check CHECK (((call_attempts >= 0) AND (call_attempts <= 1))),
    CONSTRAINT learning_cli_vector_e2e_runs_marker_sha256_check CHECK ((marker_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_cli_vector_e2e_runs_mastery_excluded_check CHECK (mastery_excluded),
    CONSTRAINT learning_cli_vector_e2e_runs_prompt_bytes_check CHECK ((prompt_bytes > 0)),
    CONSTRAINT learning_cli_vector_e2e_runs_prompt_sha256_check CHECK ((prompt_sha256 ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_cli_vector_e2e_runs_provider_check CHECK ((provider = 'claude'::text)),
    CONSTRAINT learning_cli_vector_e2e_runs_status_check CHECK ((status = ANY (ARRAY['prepared'::text, 'call_started'::text, 'captured'::text, 'indexed'::text, 'verified'::text, 'cleanup_pending'::text, 'cleaned'::text, 'failed'::text])))
);

CREATE TABLE public.learning_concept_assessment_active (
    user_id text NOT NULL,
    concept_id text NOT NULL,
    selected_at timestamp with time zone DEFAULT now() NOT NULL,
    last_indexed_at timestamp with time zone
);

CREATE TABLE public.learning_concept_assessment_attempts (
    run_id text NOT NULL,
    scope_key text NOT NULL,
    reserved_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_concept_assessment_cache (
    user_id text NOT NULL,
    concept_id text NOT NULL,
    node_version text NOT NULL,
    input_hash text NOT NULL,
    run_id text NOT NULL,
    assessment jsonb NOT NULL,
    assessed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_concept_assessment_receipts (
    run_id text NOT NULL,
    receipt jsonb NOT NULL,
    completed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_concept_assessment_runs (
    run_id text NOT NULL,
    user_id text NOT NULL,
    request_id text NOT NULL,
    concept_id text NOT NULL,
    node_version text NOT NULL,
    input_hash text NOT NULL,
    snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_concept_edges (
    curriculum_id text NOT NULL,
    from_concept_id text NOT NULL,
    to_concept_id text NOT NULL,
    kind text NOT NULL,
    confidence double precision NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT learning_concept_edges_check CHECK ((from_concept_id <> to_concept_id)),
    CONSTRAINT learning_concept_edges_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT learning_concept_edges_kind_check CHECK ((kind = ANY (ARRAY['hard-prerequisite'::text, 'related'::text])))
);

CREATE TABLE public.learning_concept_tag_budgets (
    run_id uuid NOT NULL,
    reserved_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT learning_concept_tag_budgets_failed_count_check CHECK ((failed_count >= 0)),
    CONSTRAINT learning_concept_tag_budgets_reserved_count_check CHECK ((reserved_count >= 0))
);

CREATE TABLE public.learning_concept_tag_experiments (
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    manifest jsonb NOT NULL,
    status text DEFAULT 'prepared'::text NOT NULL,
    dataset_id text,
    score_configs jsonb,
    summary jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

CREATE TABLE public.learning_concept_tag_items (
    run_id uuid NOT NULL,
    case_id text NOT NULL,
    arm text NOT NULL,
    reserved_at timestamp with time zone,
    receipt jsonb,
    export_state text DEFAULT 'pending'::text NOT NULL,
    workflow_run_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    enqueued_at timestamp with time zone
);

CREATE TABLE public.learning_concept_tag_reservations (
    run_id uuid NOT NULL,
    case_id text NOT NULL,
    chunk_index integer NOT NULL,
    request_hash text,
    owner_token uuid,
    reserved_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    state text NOT NULL,
    receipt jsonb,
    CONSTRAINT learning_concept_tag_reservations_state_check CHECK ((state = ANY (ARRAY['active'::text, 'uncertain'::text, 'succeeded'::text, 'failed'::text])))
);

CREATE TABLE public.learning_concepts (
    id text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    explanation text NOT NULL,
    example text NOT NULL,
    domain text NOT NULL,
    capability text NOT NULL,
    x double precision NOT NULL,
    y double precision NOT NULL,
    source_kind text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_concepts_source_kind_check CHECK ((source_kind = ANY (ARRAY['seed'::text, 'external'::text, 'user'::text, 'generated'::text])))
);

CREATE TABLE public.learning_consolidator_prompt_experiments (
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    seed text NOT NULL,
    manifest jsonb NOT NULL,
    dataset_id text,
    status text DEFAULT 'prepared'::text NOT NULL,
    summary jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);

CREATE TABLE public.learning_consolidator_prompt_exports (
    assessment_run_id text NOT NULL,
    experiment_id uuid NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    trace_id text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_consolidator_prompt_exports_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'queued'::text, 'sending'::text, 'exported'::text, 'uncertain'::text])))
);

CREATE TABLE public.learning_curricula (
    id text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    domain text NOT NULL,
    status text NOT NULL,
    source_kind text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    owner_user_id text,
    CONSTRAINT learning_curricula_owner_check CHECK ((((source_kind = 'seed'::text) AND (owner_user_id IS NULL)) OR ((source_kind = 'generated'::text) AND (owner_user_id IS NOT NULL)) OR (source_kind = ANY (ARRAY['external'::text, 'user'::text])))),
    CONSTRAINT learning_curricula_source_kind_check CHECK ((source_kind = ANY (ARRAY['seed'::text, 'external'::text, 'user'::text, 'generated'::text]))),
    CONSTRAINT learning_curricula_status_check CHECK ((status = ANY (ARRAY['seed'::text, 'draft'::text, 'approved'::text])))
);

CREATE TABLE public.learning_curriculum_generation_runs (
    id text NOT NULL,
    curriculum_id text,
    owner_user_id text NOT NULL,
    objective text NOT NULL,
    domain text,
    scale text,
    status text NOT NULL,
    outline jsonb,
    graph_proposal jsonb,
    shape jsonb,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    events jsonb,
    CONSTRAINT learning_curriculum_generation_runs_scale_check CHECK ((scale = ANY (ARRAY['course'::text, 'curriculum'::text]))),
    CONSTRAINT learning_curriculum_generation_runs_status_check CHECK ((status = ANY (ARRAY['interpreting'::text, 'sourcing'::text, 'fetching'::text, 'outlining'::text, 'awaiting-approval'::text, 'inferring'::text, 'writing'::text, 'completed'::text, 'failed'::text, 'rejected'::text])))
);

CREATE TABLE public.learning_curriculum_lanes (
    curriculum_id text NOT NULL,
    id text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    lane_order integer NOT NULL,
    color text NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT learning_curriculum_lanes_lane_order_check CHECK ((lane_order > 0))
);

CREATE TABLE public.learning_curriculum_module_concepts (
    curriculum_id text NOT NULL,
    module_id text NOT NULL,
    concept_id text NOT NULL,
    "position" integer NOT NULL,
    CONSTRAINT learning_curriculum_module_concepts_position_check CHECK (("position" >= 0))
);

CREATE TABLE public.learning_curriculum_module_dependencies (
    curriculum_id text NOT NULL,
    module_id text NOT NULL,
    depends_on_module_id text NOT NULL,
    confidence double precision,
    rationale text,
    CONSTRAINT learning_curriculum_module_dependencies_confidence_check CHECK (((confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))))
);

CREATE TABLE public.learning_curriculum_modules (
    curriculum_id text NOT NULL,
    id text NOT NULL,
    lane_id text NOT NULL,
    step integer NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    parent_id text,
    mastery_goals jsonb DEFAULT '[]'::jsonb NOT NULL,
    provenance jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT learning_curriculum_modules_step_check CHECK ((step > 0))
);

CREATE TABLE public.learning_curriculum_sources (
    run_id text NOT NULL,
    source_id text NOT NULL,
    provider text NOT NULL,
    title text NOT NULL,
    url text NOT NULL,
    licence text NOT NULL,
    attribution text NOT NULL,
    retrieved_at timestamp with time zone DEFAULT now() NOT NULL,
    content_chars integer DEFAULT 0 NOT NULL
);

CREATE TABLE public.learning_episode_artifacts (
    artifact_id uuid NOT NULL,
    source_episode_key text NOT NULL,
    source_fingerprint text NOT NULL,
    grouping_version text NOT NULL,
    status text NOT NULL,
    provider_thread_ids text[] DEFAULT '{}'::text[] NOT NULL,
    harness_task_ids text[] DEFAULT '{}'::text[] NOT NULL,
    domain_metadata jsonb DEFAULT '[]'::jsonb NOT NULL,
    input_snapshot jsonb NOT NULL,
    artifact jsonb NOT NULL,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_episode_artifacts_source_fingerprint_check CHECK ((source_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_episode_artifacts_status_check CHECK ((status = ANY (ARRAY['canonical'::text, 'analyzing'::text, 'completed'::text, 'partial'::text, 'failed'::text])))
);

CREATE TABLE public.learning_exposure_imports (
    import_key text NOT NULL,
    raw_version_id uuid,
    status text NOT NULL,
    gap_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_exposure_imports_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'gap'::text])))
);

CREATE TABLE public.learning_exposure_observations (
    observation_id uuid NOT NULL,
    dedupe_key text,
    logical_message_key text,
    direction text NOT NULL,
    visible boolean NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    raw_version_id uuid NOT NULL,
    payload jsonb NOT NULL,
    payload_sha256 text NOT NULL,
    inserted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_exposure_observations_direction_check CHECK ((direction = ANY (ARRAY['user_to_model'::text, 'model_to_user'::text, 'internal'::text, 'unknown'::text]))),
    CONSTRAINT learning_exposure_observations_payload_sha256_check CHECK ((payload_sha256 ~ '^[a-f0-9]{64}$'::text))
);

CREATE TABLE public.learning_exposure_projection_cursors (
    source_id uuid NOT NULL,
    generation integer NOT NULL,
    cursor_offset bigint DEFAULT 0 NOT NULL,
    source_order bigint DEFAULT 0 NOT NULL,
    parser_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_exposure_projection_cursors_cursor_offset_check CHECK ((cursor_offset >= 0)),
    CONSTRAINT learning_exposure_projection_cursors_source_order_check CHECK ((source_order >= 0))
);

CREATE TABLE public.learning_exposure_work (
    work_key text NOT NULL,
    token uuid,
    lease_until timestamp with time zone,
    cursor jsonb DEFAULT '{}'::jsonb NOT NULL,
    counters jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_exposure_work_check CHECK (((token IS NULL) = (lease_until IS NULL)))
);

CREATE TABLE public.learning_extraction_benchmark_cases (
    run_id text NOT NULL,
    case_id text NOT NULL,
    ordinal integer NOT NULL,
    provider text NOT NULL,
    agent text NOT NULL,
    thread_id text NOT NULL,
    turn_id text NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    input_hash text NOT NULL,
    input_snapshot jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    judge_output jsonb,
    judge_duration_ms integer,
    error text,
    CONSTRAINT learning_extraction_benchmark_cases_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])))
);

CREATE TABLE public.learning_extraction_benchmark_results (
    run_id text NOT NULL,
    case_id text NOT NULL,
    model text NOT NULL,
    effort text NOT NULL,
    status text NOT NULL,
    extraction jsonb,
    duration_ms integer NOT NULL,
    input_tokens integer,
    output_tokens integer,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_extraction_benchmark_results_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))
);

CREATE TABLE public.learning_extraction_benchmark_runs (
    run_id text NOT NULL,
    status text NOT NULL,
    sample_size integer NOT NULL,
    config jsonb NOT NULL,
    source_counts jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    output_tokens bigint,
    CONSTRAINT learning_extraction_benchmark_runs_sample_size_check CHECK ((sample_size > 0)),
    CONSTRAINT learning_extraction_benchmark_runs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'completed'::text, 'partial'::text, 'failed'::text, 'cancelled'::text])))
);

COMMENT ON COLUMN public.learning_extraction_benchmark_runs.output_tokens IS 'Sum of actual provider-call output tokens for this run; NULL when unknown. No visible/reasoning token split is implied.';

CREATE TABLE public.learning_extraction_human_reviews (
    run_id text NOT NULL,
    case_id text NOT NULL,
    reviewer_id text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    preferred_winner text,
    component_reviews jsonb DEFAULT '{}'::jsonb NOT NULL,
    notes text DEFAULT ''::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_extraction_human_reviews_preferred_winner_check CHECK ((preferred_winner = ANY (ARRAY['A'::text, 'B'::text, 'tie'::text, 'unsure'::text]))),
    CONSTRAINT learning_extraction_human_reviews_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text])))
);

CREATE TABLE public.learning_extractor_config (
    config_key text NOT NULL,
    backend text NOT NULL,
    model text NOT NULL,
    effort text NOT NULL,
    updated_by text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_extractor_config_config_key_check CHECK ((config_key = 'default'::text))
);

CREATE TABLE public.learning_feedback_traces (
    id uuid NOT NULL,
    user_id text NOT NULL,
    session_id text NOT NULL,
    turn_id uuid NOT NULL,
    phase text NOT NULL,
    payload jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    exported_at timestamp with time zone,
    export_result jsonb,
    CONSTRAINT learning_feedback_traces_phase_check CHECK ((phase = ANY (ARRAY['injection'::text, 'submission'::text]))),
    CONSTRAINT learning_feedback_traces_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'queued'::text, 'sending'::text, 'exported'::text, 'uncertain'::text])))
);

CREATE TABLE public.learning_hindsight_agy_bridge_requests (
    request_id text NOT NULL,
    experiment_id text NOT NULL,
    operation_id text NOT NULL,
    operation_call_budget integer NOT NULL,
    request_sha256 character(64) NOT NULL,
    status text NOT NULL,
    backend text NOT NULL,
    requested_model text NOT NULL,
    requested_effort text NOT NULL,
    timeout_seconds integer NOT NULL,
    attempt_limit integer NOT NULL,
    requested_max_output_tokens integer,
    max_output_tokens_enforced boolean DEFAULT false NOT NULL,
    requested_temperature double precision,
    temperature_enforced boolean DEFAULT false NOT NULL,
    request_body jsonb NOT NULL,
    response_body jsonb,
    usage jsonb,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT learning_hindsight_agy_bridge__max_output_tokens_enforced_check CHECK ((max_output_tokens_enforced = false)),
    CONSTRAINT learning_hindsight_agy_bridge_reque_operation_call_budget_check CHECK (((operation_call_budget >= 1) AND (operation_call_budget <= 64))),
    CONSTRAINT learning_hindsight_agy_bridge_reques_temperature_enforced_check CHECK ((temperature_enforced = false)),
    CONSTRAINT learning_hindsight_agy_bridge_requests_attempt_limit_check CHECK ((attempt_limit = 1)),
    CONSTRAINT learning_hindsight_agy_bridge_requests_backend_check CHECK ((backend = 'agy'::text)),
    CONSTRAINT learning_hindsight_agy_bridge_requests_check CHECK ((((status = 'running'::text) AND (response_body IS NULL) AND (error IS NULL) AND (completed_at IS NULL)) OR ((status = 'completed'::text) AND (response_body IS NOT NULL) AND (error IS NULL) AND (completed_at IS NOT NULL)) OR ((status = 'failed'::text) AND (response_body IS NULL) AND (error IS NOT NULL) AND (completed_at IS NOT NULL)))),
    CONSTRAINT learning_hindsight_agy_bridge_requests_requested_effort_check CHECK ((requested_effort = 'high'::text)),
    CONSTRAINT learning_hindsight_agy_bridge_requests_requested_model_check CHECK ((requested_model = 'gemini-3.7-flash'::text)),
    CONSTRAINT learning_hindsight_agy_bridge_requests_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text]))),
    CONSTRAINT learning_hindsight_agy_bridge_requests_timeout_seconds_check CHECK ((timeout_seconds = 420))
);

COMMENT ON TABLE public.learning_hindsight_agy_bridge_requests IS 'Private one-attempt request and response receipts for the loopback-only Hindsight OpenAI-compatible AGY bridge.';

CREATE TABLE public.learning_hindsight_consolidation_triggers (
    bank_id text NOT NULL,
    scope_key text NOT NULL,
    available_sequence bigint DEFAULT 0 NOT NULL,
    available_watermark text,
    available_pending_facts integer DEFAULT 0 NOT NULL,
    available_oldest_at timestamp with time zone,
    reserved_watermark text,
    reserved_sequence bigint,
    completed_watermark text,
    reservation_token uuid,
    reservation_until timestamp with time zone,
    native_operation_id uuid,
    native_submitted_at timestamp with time zone,
    native_deadline_at timestamp with time zone,
    status text DEFAULT 'idle'::text NOT NULL,
    poll_count integer DEFAULT 0 NOT NULL,
    next_poll_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_hindsight_consolidation__available_pending_facts_check CHECK ((available_pending_facts >= 0)),
    CONSTRAINT learning_hindsight_consolidation_trigg_available_sequence_check CHECK ((available_sequence >= 0)),
    CONSTRAINT learning_hindsight_consolidation_triggers_check CHECK ((((reservation_token IS NULL) AND (reservation_until IS NULL)) OR ((reservation_token IS NOT NULL) AND (reservation_until IS NOT NULL)))),
    CONSTRAINT learning_hindsight_consolidation_triggers_poll_count_check CHECK ((poll_count >= 0)),
    CONSTRAINT learning_hindsight_consolidation_triggers_status_check CHECK ((status = ANY (ARRAY['idle'::text, 'reserved'::text, 'polling'::text, 'completed'::text, 'failed'::text, 'uncertain'::text])))
);

COMMENT ON TABLE public.learning_hindsight_consolidation_triggers IS 'No-text durable watermark/reservation checkpoint for the disabled-by-default native Hindsight consolidation trigger.';

CREATE TABLE public.learning_hook_events (
    event_id text NOT NULL,
    provider text NOT NULL,
    source_event text NOT NULL,
    kind text NOT NULL,
    role text,
    text text,
    thread_id text NOT NULL,
    exchange_id text NOT NULL,
    agent text NOT NULL,
    agent_id text,
    transcript_path text,
    cwd text,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    model text,
    CONSTRAINT learning_hook_events_kind_check CHECK ((kind = ANY (ARRAY['turn'::text, 'session'::text]))),
    CONSTRAINT learning_hook_events_provider_check CHECK ((provider = ANY (ARRAY['anthropic'::text, 'openai'::text]))),
    CONSTRAINT learning_hook_events_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);

CREATE TABLE public.learning_hook_health_events (
    event_id bigint NOT NULL,
    user_id text NOT NULL,
    provider text NOT NULL,
    session_id text NOT NULL,
    level text NOT NULL,
    kind text NOT NULL,
    stage text,
    detail text,
    status integer,
    occurred_at timestamp with time zone NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_hook_health_events_kind_check CHECK ((kind = ANY (ARRAY['session_disabled'::text, 'session_enabled'::text, 'service_delayed'::text, 'hook_failed'::text]))),
    CONSTRAINT learning_hook_health_events_level_check CHECK ((level = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text]))),
    CONSTRAINT learning_hook_health_events_provider_check CHECK ((provider = ANY (ARRAY['claude'::text, 'codex'::text])))
);

ALTER TABLE public.learning_hook_health_events ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.learning_hook_health_events_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE public.learning_index_admission (
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    requested_generation bigint DEFAULT 0 NOT NULL,
    captured_generation bigint DEFAULT 0 NOT NULL,
    dispatch_id uuid,
    run_id uuid,
    active_slot integer,
    attempts integer DEFAULT 0 NOT NULL,
    last_notified_at timestamp with time zone DEFAULT now() NOT NULL,
    last_finished_at timestamp with time zone,
    last_run_id uuid,
    last_failure text,
    CONSTRAINT learning_active_archive_sessions_active_slot_check CHECK (((active_slot >= 1) AND (active_slot <= 3))),
    CONSTRAINT learning_active_archive_sessions_attempts_check CHECK (((attempts >= 0) AND (attempts <= 3))),
    CONSTRAINT learning_active_archive_sessions_check CHECK ((captured_generation <= requested_generation)),
    CONSTRAINT learning_index_admission_active_slot_check CHECK ((active_slot = 1))
);

CREATE TABLE public.learning_index_notifications (
    invocation_id uuid NOT NULL,
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_live_feedback_turns (
    user_id text NOT NULL,
    session_id text NOT NULL,
    turn_id uuid NOT NULL,
    message text NOT NULL,
    foundation_first boolean NOT NULL,
    catalog_version text NOT NULL,
    feedback jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    submitted_at timestamp with time zone
);

CREATE TABLE public.learning_outcome_steering_dimensions (
    evaluation_id uuid NOT NULL,
    dimension text NOT NULL,
    status text NOT NULL,
    estimate double precision,
    confidence double precision NOT NULL,
    rationale text NOT NULL,
    observed_domains jsonb DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT learning_outcome_steering_dimensions_confidence_check CHECK (((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))),
    CONSTRAINT learning_outcome_steering_dimensions_estimate_check CHECK (((estimate IS NULL) OR ((estimate >= (0)::double precision) AND (estimate <= (1)::double precision)))),
    CONSTRAINT learning_outcome_steering_dimensions_status_check CHECK ((status = ANY (ARRAY['judged'::text, 'abstained'::text])))
);

CREATE TABLE public.learning_outcome_steering_evaluations (
    evaluation_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    evaluator_version text NOT NULL,
    config_hash text NOT NULL,
    backend text NOT NULL,
    model text NOT NULL,
    effort text NOT NULL,
    status text NOT NULL,
    claim_token uuid,
    lease_expires_at timestamp with time zone,
    raw_judgment jsonb,
    summary text,
    limitations jsonb DEFAULT '[]'::jsonb NOT NULL,
    error text,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_outcome_steering_evaluations_config_hash_check CHECK ((config_hash ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT learning_outcome_steering_evaluations_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'abstained'::text, 'failed'::text])))
);

CREATE TABLE public.learning_outcome_steering_evidence (
    evaluation_id uuid NOT NULL,
    dimension text NOT NULL,
    ref_id text NOT NULL
);

CREATE TABLE public.learning_playground_response_attempts (
    request_id text NOT NULL,
    user_id text NOT NULL,
    input_hash text NOT NULL,
    reserved_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_playground_response_receipts (
    request_id text NOT NULL,
    receipt jsonb NOT NULL
);

CREATE TABLE public.learning_reactive_admission (
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    requested_generation bigint DEFAULT 0 NOT NULL,
    captured_generation bigint DEFAULT 0 NOT NULL,
    dispatch_id uuid,
    run_id uuid,
    active_slot integer,
    attempts integer DEFAULT 0 NOT NULL,
    last_notified_at timestamp with time zone DEFAULT now() NOT NULL,
    last_finished_at timestamp with time zone,
    last_run_id uuid,
    last_failure text,
    CONSTRAINT learning_active_archive_sessions_attempts_check CHECK (((attempts >= 0) AND (attempts <= 3))),
    CONSTRAINT learning_active_archive_sessions_check CHECK ((captured_generation <= requested_generation)),
    CONSTRAINT learning_reactive_admission_active_slot_check CHECK (((active_slot >= 1) AND (active_slot <= 9)))
);

CREATE TABLE public.learning_reactive_admission_settled_20261021 (
    user_id text,
    session_id uuid,
    requested_generation bigint,
    captured_generation bigint,
    dispatch_id uuid,
    run_id uuid,
    active_slot integer,
    attempts integer,
    last_notified_at timestamp with time zone,
    last_finished_at timestamp with time zone,
    last_run_id uuid,
    last_failure text,
    concept_id text
);

CREATE TABLE public.learning_reactive_embeddings (
    revision text NOT NULL,
    concepts jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_reactive_notifications (
    invocation_id uuid NOT NULL,
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_reactive_routes (
    user_id text NOT NULL,
    message_id text NOT NULL,
    revision text NOT NULL,
    matches jsonb NOT NULL,
    routed_at timestamp with time zone DEFAULT now() NOT NULL,
    event_id uuid NOT NULL
);

CREATE TABLE public.learning_reactive_settings (
    user_id text NOT NULL,
    enabled boolean DEFAULT false NOT NULL,
    activated_at timestamp with time zone DEFAULT now() NOT NULL,
    config jsonb NOT NULL,
    revision text NOT NULL,
    last_error text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_reactive_targets (
    user_id text NOT NULL,
    session_id uuid NOT NULL,
    concept_id text NOT NULL
);

CREATE TABLE public.learning_semantic_index_chunks (
    chunk_id text NOT NULL,
    message_id text NOT NULL,
    ordinal integer NOT NULL,
    start_offset integer NOT NULL,
    end_offset integer NOT NULL,
    token_count integer NOT NULL,
    tokenizer_sha256 text NOT NULL,
    content_sha256 text NOT NULL,
    operation_id uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error text,
    indexed_at timestamp with time zone,
    CONSTRAINT learning_semantic_index_chunks_check CHECK ((end_offset > start_offset)),
    CONSTRAINT learning_semantic_index_chunks_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'submitted'::text, 'indexed'::text, 'error'::text]))),
    CONSTRAINT learning_semantic_index_chunks_token_count_check CHECK ((token_count <= 480))
);

CREATE TABLE public.learning_semantic_index_members (
    run_id uuid NOT NULL,
    message_id text NOT NULL
);

CREATE TABLE public.learning_semantic_index_messages (
    message_id text NOT NULL,
    observation_id uuid NOT NULL,
    logical_message_key text NOT NULL,
    raw_version_id uuid NOT NULL,
    conversation_id text NOT NULL,
    role text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    payload jsonb NOT NULL,
    source_text text NOT NULL,
    source_sha256 text NOT NULL,
    parts jsonb NOT NULL,
    media_count integer DEFAULT 0 NOT NULL,
    current_canonical boolean DEFAULT true NOT NULL,
    status text NOT NULL,
    error text,
    indexed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_semantic_index_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text]))),
    CONSTRAINT learning_semantic_index_messages_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'chunked'::text, 'indexed'::text, 'empty'::text, 'media_only'::text, 'unsupported'::text, 'error'::text])))
);

CREATE TABLE public.learning_semantic_index_operations (
    operation_id uuid NOT NULL,
    chunk_ids jsonb NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.learning_semantic_index_runs (
    run_id uuid NOT NULL,
    frozen_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    watermark text NOT NULL,
    scope text DEFAULT 'all-queryable'::text NOT NULL,
    canonical_messages integer DEFAULT 0 NOT NULL,
    raw_observations integer DEFAULT 0 NOT NULL,
    error text
);

CREATE TABLE public.learning_transcript_archive_checkpoints (
    source_path text NOT NULL,
    provider text NOT NULL,
    source_kind text NOT NULL,
    device_id bigint NOT NULL,
    inode_id bigint NOT NULL,
    generation integer DEFAULT 0 NOT NULL,
    source_cursor bigint DEFAULT 0 NOT NULL,
    record_order bigint DEFAULT 0 NOT NULL,
    parser_state jsonb DEFAULT '{}'::jsonb NOT NULL,
    last_scanned_at timestamp with time zone,
    last_archived_at timestamp with time zone,
    last_document_id text,
    last_content_hash text,
    last_error text,
    last_error_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_transcript_archive_checkpoints_generation_check CHECK ((generation >= 0)),
    CONSTRAINT learning_transcript_archive_checkpoints_provider_check CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'google'::text]))),
    CONSTRAINT learning_transcript_archive_checkpoints_record_order_check CHECK ((record_order >= 0)),
    CONSTRAINT learning_transcript_archive_checkpoints_source_cursor_check CHECK ((source_cursor >= 0)),
    CONSTRAINT learning_transcript_archive_checkpoints_source_kind_check CHECK ((source_kind = ANY (ARRAY['jsonl'::text, 'sqlite'::text])))
);

CREATE TABLE public.learning_turn_context_decisions (
    decision_id text NOT NULL,
    event_id text NOT NULL,
    provider text NOT NULL,
    agent text NOT NULL,
    thread_id text NOT NULL,
    turn_id text NOT NULL,
    input_snapshot jsonb NOT NULL,
    extraction jsonb,
    packet jsonb NOT NULL,
    extractor_config jsonb NOT NULL,
    status text NOT NULL,
    latency_ms integer NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT learning_turn_context_decisions_status_check CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))
);

CREATE TABLE public.learning_vector_arrivals (
    message_id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    event_id uuid DEFAULT gen_random_uuid() NOT NULL
);

CREATE TABLE public.learning_vector_turn_assessments (
    experiment_id uuid NOT NULL,
    concept_id text NOT NULL,
    part integer NOT NULL,
    run_id text NOT NULL
);

CREATE TABLE public.learning_vector_turn_experiments (
    run_id uuid NOT NULL,
    user_id text NOT NULL,
    label text DEFAULT 'dev1: vector+turns'::text NOT NULL,
    config jsonb NOT NULL,
    snapshot jsonb,
    status text DEFAULT 'preparing'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone
);

CREATE TABLE public.telemetry_outbox (
    id uuid NOT NULL,
    destination text NOT NULL,
    dedupe_key text NOT NULL,
    payload jsonb,
    payload_fingerprint text NOT NULL,
    compacted_at timestamp with time zone,
    state text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_token uuid,
    lease_until timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delivered_at timestamp with time zone,
    CONSTRAINT telemetry_outbox_attempts_check CHECK (((attempts >= 0) AND (attempts <= 8))),
    CONSTRAINT telemetry_outbox_check CHECK (((state = 'delivering'::text) = ((lease_token IS NOT NULL) AND (lease_until IS NOT NULL)))),
    CONSTRAINT telemetry_outbox_check1 CHECK ((((payload IS NOT NULL) AND (compacted_at IS NULL)) OR ((payload IS NULL) AND (compacted_at IS NOT NULL) AND (state = ANY (ARRAY['delivered'::text, 'dead'::text]))))),
    CONSTRAINT telemetry_outbox_dedupe_key_check CHECK (((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 512))),
    CONSTRAINT telemetry_outbox_destination_check CHECK (((length(destination) >= 1) AND (length(destination) <= 80))),
    CONSTRAINT telemetry_outbox_payload_fingerprint_check CHECK ((payload_fingerprint ~ '^[a-f0-9]{64}$'::text)),
    CONSTRAINT telemetry_outbox_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'delivering'::text, 'delivered'::text, 'dead'::text])))
);

ALTER TABLE ONLY public.learning_active_archive_notifications
    ADD CONSTRAINT learning_active_archive_notifications_pkey PRIMARY KEY (invocation_id);

ALTER TABLE ONLY public.learning_active_archive_sessions
    ADD CONSTRAINT learning_active_archive_sessions_active_slot_key UNIQUE (active_slot);

ALTER TABLE ONLY public.learning_active_archive_sessions
    ADD CONSTRAINT learning_active_archive_sessions_pkey PRIMARY KEY (user_id, session_id);

ALTER TABLE ONLY public.learning_archive_blobs
    ADD CONSTRAINT learning_archive_blobs_pkey PRIMARY KEY (sha256);

ALTER TABLE ONLY public.learning_archive_checkpoints
    ADD CONSTRAINT learning_archive_checkpoints_pkey PRIMARY KEY (source_id, generation);

ALTER TABLE ONLY public.learning_archive_errors
    ADD CONSTRAINT learning_archive_errors_pkey PRIMARY KEY (error_id);

ALTER TABLE ONLY public.learning_archive_runs
    ADD CONSTRAINT learning_archive_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_archive_sources
    ADD CONSTRAINT learning_archive_sources_host_provider_root_path_relative_p_key UNIQUE (host, provider, root_path, relative_path);

ALTER TABLE ONLY public.learning_archive_sources
    ADD CONSTRAINT learning_archive_sources_pkey PRIMARY KEY (source_id);

ALTER TABLE ONLY public.learning_archive_version_chunks
    ADD CONSTRAINT learning_archive_version_chunks_pkey PRIMARY KEY (version_id, chunk_ordinal);

ALTER TABLE ONLY public.learning_archive_version_chunks
    ADD CONSTRAINT learning_archive_version_chunks_version_id_byte_offset_key UNIQUE (version_id, byte_offset);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_capture_key_key UNIQUE (capture_key);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_pkey PRIMARY KEY (version_id);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_source_id_generation_version_numb_key UNIQUE (source_id, generation, version_number);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_version_id_source_id_generation_key UNIQUE (version_id, source_id, generation);

ALTER TABLE ONLY public.learning_cli_vector_e2e_runs
    ADD CONSTRAINT learning_cli_vector_e2e_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_cli_vector_e2e_runs
    ADD CONSTRAINT learning_cli_vector_e2e_runs_session_id_key UNIQUE (session_id);

ALTER TABLE ONLY public.learning_cli_vector_e2e_runs
    ADD CONSTRAINT learning_cli_vector_e2e_runs_source_id_key UNIQUE (source_id);

ALTER TABLE ONLY public.learning_cli_vector_e2e_runs
    ADD CONSTRAINT learning_cli_vector_e2e_runs_source_path_key UNIQUE (source_path);

ALTER TABLE ONLY public.learning_concept_assessment_active
    ADD CONSTRAINT learning_concept_assessment_active_pkey PRIMARY KEY (user_id, concept_id);

ALTER TABLE ONLY public.learning_concept_assessment_attempts
    ADD CONSTRAINT learning_concept_assessment_attempts_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_concept_assessment_attempts
    ADD CONSTRAINT learning_concept_assessment_attempts_scope_key_key UNIQUE (scope_key);

ALTER TABLE ONLY public.learning_concept_assessment_cache
    ADD CONSTRAINT learning_concept_assessment_cache_pkey PRIMARY KEY (user_id, concept_id);

ALTER TABLE ONLY public.learning_concept_assessment_receipts
    ADD CONSTRAINT learning_concept_assessment_receipts_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_concept_assessment_runs
    ADD CONSTRAINT learning_concept_assessment_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_concept_assessment_runs
    ADD CONSTRAINT learning_concept_assessment_runs_user_id_request_id_key UNIQUE (user_id, request_id);

ALTER TABLE ONLY public.learning_concept_edges
    ADD CONSTRAINT learning_concept_edges_pkey PRIMARY KEY (curriculum_id, from_concept_id, to_concept_id, kind);

ALTER TABLE ONLY public.learning_concept_tag_budgets
    ADD CONSTRAINT learning_concept_tag_budgets_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_concept_tag_experiments
    ADD CONSTRAINT learning_concept_tag_experiments_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_concept_tag_items
    ADD CONSTRAINT learning_concept_tag_items_pkey PRIMARY KEY (run_id, case_id, arm);

ALTER TABLE ONLY public.learning_concept_tag_reservations
    ADD CONSTRAINT learning_concept_tag_reservations_pkey PRIMARY KEY (run_id, case_id, chunk_index);

ALTER TABLE ONLY public.learning_concepts
    ADD CONSTRAINT learning_concepts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.learning_consolidator_prompt_experiments
    ADD CONSTRAINT learning_consolidator_prompt_experiments_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_consolidator_prompt_exports
    ADD CONSTRAINT learning_consolidator_prompt_exports_pkey PRIMARY KEY (assessment_run_id);

ALTER TABLE ONLY public.learning_curricula
    ADD CONSTRAINT learning_curricula_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.learning_curriculum_generation_runs
    ADD CONSTRAINT learning_curriculum_generation_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.learning_curriculum_lanes
    ADD CONSTRAINT learning_curriculum_lanes_curriculum_id_lane_order_key UNIQUE (curriculum_id, lane_order);

ALTER TABLE ONLY public.learning_curriculum_lanes
    ADD CONSTRAINT learning_curriculum_lanes_pkey PRIMARY KEY (curriculum_id, id);

ALTER TABLE ONLY public.learning_curriculum_module_concepts
    ADD CONSTRAINT learning_curriculum_module_co_curriculum_id_module_id_posit_key UNIQUE (curriculum_id, module_id, "position");

ALTER TABLE ONLY public.learning_curriculum_module_concepts
    ADD CONSTRAINT learning_curriculum_module_concepts_pkey PRIMARY KEY (curriculum_id, module_id, concept_id);

ALTER TABLE ONLY public.learning_curriculum_module_dependencies
    ADD CONSTRAINT learning_curriculum_module_dependencies_pkey PRIMARY KEY (curriculum_id, module_id, depends_on_module_id);

ALTER TABLE ONLY public.learning_curriculum_modules
    ADD CONSTRAINT learning_curriculum_modules_curriculum_id_step_key UNIQUE (curriculum_id, step);

ALTER TABLE ONLY public.learning_curriculum_modules
    ADD CONSTRAINT learning_curriculum_modules_pkey PRIMARY KEY (curriculum_id, id);

ALTER TABLE ONLY public.learning_curriculum_sources
    ADD CONSTRAINT learning_curriculum_sources_pkey PRIMARY KEY (run_id, source_id);

ALTER TABLE ONLY public.learning_episode_artifacts
    ADD CONSTRAINT learning_episode_artifacts_pkey PRIMARY KEY (artifact_id);

ALTER TABLE ONLY public.learning_episode_artifacts
    ADD CONSTRAINT learning_episode_artifacts_source_fingerprint_key UNIQUE (source_fingerprint);

ALTER TABLE ONLY public.learning_exposure_imports
    ADD CONSTRAINT learning_exposure_imports_pkey PRIMARY KEY (import_key);

ALTER TABLE ONLY public.learning_exposure_observations
    ADD CONSTRAINT learning_exposure_observations_pkey PRIMARY KEY (observation_id);

ALTER TABLE ONLY public.learning_exposure_projection_cursors
    ADD CONSTRAINT learning_exposure_projection_cursors_pkey PRIMARY KEY (source_id, generation);

ALTER TABLE ONLY public.learning_exposure_work
    ADD CONSTRAINT learning_exposure_work_pkey PRIMARY KEY (work_key);

ALTER TABLE ONLY public.learning_extraction_benchmark_cases
    ADD CONSTRAINT learning_extraction_benchmark_cases_pkey PRIMARY KEY (run_id, case_id);

ALTER TABLE ONLY public.learning_extraction_benchmark_cases
    ADD CONSTRAINT learning_extraction_benchmark_cases_run_id_ordinal_key UNIQUE (run_id, ordinal);

ALTER TABLE ONLY public.learning_extraction_benchmark_results
    ADD CONSTRAINT learning_extraction_benchmark_results_pkey PRIMARY KEY (run_id, case_id, model, effort);

ALTER TABLE ONLY public.learning_extraction_benchmark_runs
    ADD CONSTRAINT learning_extraction_benchmark_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_extraction_human_reviews
    ADD CONSTRAINT learning_extraction_human_reviews_pkey PRIMARY KEY (run_id, case_id);

ALTER TABLE ONLY public.learning_extractor_config
    ADD CONSTRAINT learning_extractor_config_pkey PRIMARY KEY (config_key);

ALTER TABLE ONLY public.learning_feedback_traces
    ADD CONSTRAINT learning_feedback_traces_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.learning_feedback_traces
    ADD CONSTRAINT learning_feedback_traces_user_id_session_id_turn_id_phase_key UNIQUE (user_id, session_id, turn_id, phase);

ALTER TABLE ONLY public.learning_hindsight_agy_bridge_requests
    ADD CONSTRAINT learning_hindsight_agy_bridge_experiment_id_operation_id_re_key UNIQUE (experiment_id, operation_id, request_sha256);

ALTER TABLE ONLY public.learning_hindsight_agy_bridge_requests
    ADD CONSTRAINT learning_hindsight_agy_bridge_requests_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.learning_hindsight_consolidation_triggers
    ADD CONSTRAINT learning_hindsight_consolidation_triggers_pkey PRIMARY KEY (bank_id, scope_key);

ALTER TABLE ONLY public.learning_hook_events
    ADD CONSTRAINT learning_hook_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.learning_hook_health_events
    ADD CONSTRAINT learning_hook_health_events_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.learning_index_admission
    ADD CONSTRAINT learning_index_admission_active_slot_key UNIQUE (active_slot);

ALTER TABLE ONLY public.learning_index_admission
    ADD CONSTRAINT learning_index_admission_pkey PRIMARY KEY (user_id, session_id);

ALTER TABLE ONLY public.learning_index_notifications
    ADD CONSTRAINT learning_index_notifications_pkey PRIMARY KEY (invocation_id);

ALTER TABLE ONLY public.learning_live_feedback_turns
    ADD CONSTRAINT learning_live_feedback_turns_pkey PRIMARY KEY (user_id, session_id, turn_id);

ALTER TABLE ONLY public.learning_outcome_steering_dimensions
    ADD CONSTRAINT learning_outcome_steering_dimensions_pkey PRIMARY KEY (evaluation_id, dimension);

ALTER TABLE ONLY public.learning_outcome_steering_evaluations
    ADD CONSTRAINT learning_outcome_steering_eva_artifact_id_evaluator_version_key UNIQUE (artifact_id, evaluator_version, config_hash);

ALTER TABLE ONLY public.learning_outcome_steering_evaluations
    ADD CONSTRAINT learning_outcome_steering_evaluations_pkey PRIMARY KEY (evaluation_id);

ALTER TABLE ONLY public.learning_outcome_steering_evidence
    ADD CONSTRAINT learning_outcome_steering_evidence_pkey PRIMARY KEY (evaluation_id, dimension, ref_id);

ALTER TABLE ONLY public.learning_playground_response_attempts
    ADD CONSTRAINT learning_playground_response_attempts_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.learning_playground_response_receipts
    ADD CONSTRAINT learning_playground_response_receipts_pkey PRIMARY KEY (request_id);

ALTER TABLE ONLY public.learning_reactive_admission
    ADD CONSTRAINT learning_reactive_admission_active_slot_key UNIQUE (active_slot);

ALTER TABLE ONLY public.learning_reactive_admission
    ADD CONSTRAINT learning_reactive_admission_pkey PRIMARY KEY (user_id, session_id);

ALTER TABLE ONLY public.learning_reactive_embeddings
    ADD CONSTRAINT learning_reactive_embeddings_pkey PRIMARY KEY (revision);

ALTER TABLE ONLY public.learning_reactive_notifications
    ADD CONSTRAINT learning_reactive_notifications_pkey PRIMARY KEY (invocation_id);

ALTER TABLE ONLY public.learning_reactive_routes
    ADD CONSTRAINT learning_reactive_routes_pkey PRIMARY KEY (user_id, event_id, revision);

ALTER TABLE ONLY public.learning_reactive_settings
    ADD CONSTRAINT learning_reactive_settings_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.learning_reactive_targets
    ADD CONSTRAINT learning_reactive_targets_pkey PRIMARY KEY (user_id, session_id);

ALTER TABLE ONLY public.learning_reactive_targets
    ADD CONSTRAINT learning_reactive_targets_user_id_concept_id_key UNIQUE (user_id, concept_id);

ALTER TABLE ONLY public.learning_semantic_index_chunks
    ADD CONSTRAINT learning_semantic_index_chunks_message_id_ordinal_key UNIQUE (message_id, ordinal);

ALTER TABLE ONLY public.learning_semantic_index_chunks
    ADD CONSTRAINT learning_semantic_index_chunks_pkey PRIMARY KEY (chunk_id);

ALTER TABLE ONLY public.learning_semantic_index_members
    ADD CONSTRAINT learning_semantic_index_members_pkey PRIMARY KEY (run_id, message_id);

ALTER TABLE ONLY public.learning_semantic_index_messages
    ADD CONSTRAINT learning_semantic_index_messages_pkey PRIMARY KEY (message_id);

ALTER TABLE ONLY public.learning_semantic_index_operations
    ADD CONSTRAINT learning_semantic_index_operations_pkey PRIMARY KEY (operation_id);

ALTER TABLE ONLY public.learning_semantic_index_runs
    ADD CONSTRAINT learning_semantic_index_runs_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_transcript_archive_checkpoints
    ADD CONSTRAINT learning_transcript_archive_checkpoints_pkey PRIMARY KEY (source_path);

ALTER TABLE ONLY public.learning_turn_context_decisions
    ADD CONSTRAINT learning_turn_context_decisions_event_id_key UNIQUE (event_id);

ALTER TABLE ONLY public.learning_turn_context_decisions
    ADD CONSTRAINT learning_turn_context_decisions_pkey PRIMARY KEY (decision_id);

ALTER TABLE ONLY public.learning_vector_arrivals
    ADD CONSTRAINT learning_vector_arrivals_pkey PRIMARY KEY (event_id);

ALTER TABLE ONLY public.learning_vector_turn_assessments
    ADD CONSTRAINT learning_vector_turn_assessments_pkey PRIMARY KEY (experiment_id, concept_id, part);

ALTER TABLE ONLY public.learning_vector_turn_experiments
    ADD CONSTRAINT learning_vector_turn_experiments_pkey PRIMARY KEY (run_id);

ALTER TABLE ONLY public.learning_vector_turn_experiments
    ADD CONSTRAINT learning_vector_turn_experiments_user_id_run_id_key UNIQUE (user_id, run_id);

ALTER TABLE ONLY public.telemetry_outbox
    ADD CONSTRAINT telemetry_outbox_destination_dedupe_key_key UNIQUE (destination, dedupe_key);

ALTER TABLE ONLY public.telemetry_outbox
    ADD CONSTRAINT telemetry_outbox_pkey PRIMARY KEY (id);

CREATE INDEX learning_active_archive_dirty ON public.learning_active_archive_sessions USING btree (last_notified_at) WHERE (requested_generation > captured_generation);

CREATE INDEX learning_archive_errors_run_idx ON public.learning_archive_errors USING btree (run_id, observed_at DESC);

CREATE INDEX learning_archive_errors_source_idx ON public.learning_archive_errors USING btree (source_id, observed_at DESC);

CREATE INDEX learning_archive_sources_backlog_idx ON public.learning_archive_sources USING btree (discovery_state, last_success_at NULLS FIRST);

CREATE INDEX learning_archive_sources_lease_idx ON public.learning_archive_sources USING btree (lease_expires_at) WHERE (lease_token IS NOT NULL);

CREATE INDEX learning_archive_versions_source_idx ON public.learning_archive_versions USING btree (source_id, generation, version_number DESC);

CREATE INDEX learning_cli_vector_e2e_active_session ON public.learning_cli_vector_e2e_runs USING btree (session_id) WHERE (status <> 'cleaned'::text);

CREATE INDEX learning_concept_edges_to_idx ON public.learning_concept_edges USING btree (curriculum_id, to_concept_id);

CREATE INDEX learning_concept_tag_reservations_pending ON public.learning_concept_tag_reservations USING btree (run_id, state, lease_until) WHERE (state = ANY (ARRAY['active'::text, 'uncertain'::text]));

CREATE INDEX learning_curricula_owner_idx ON public.learning_curricula USING btree (owner_user_id, status) WHERE (owner_user_id IS NOT NULL);

CREATE INDEX learning_curriculum_generation_runs_owner_idx ON public.learning_curriculum_generation_runs USING btree (owner_user_id, created_at DESC);

CREATE INDEX learning_curriculum_module_concepts_concept_idx ON public.learning_curriculum_module_concepts USING btree (concept_id, curriculum_id);

CREATE INDEX learning_curriculum_modules_lane_idx ON public.learning_curriculum_modules USING btree (curriculum_id, lane_id, step);

CREATE INDEX learning_episode_artifacts_source_idx ON public.learning_episode_artifacts USING btree (source_episode_key, created_at DESC);

CREATE UNIQUE INDEX learning_exposure_dedupe_idx ON public.learning_exposure_observations USING btree (dedupe_key) WHERE (dedupe_key IS NOT NULL);

CREATE INDEX learning_exposure_message_idx ON public.learning_exposure_observations USING btree (logical_message_key, direction);

CREATE INDEX learning_exposure_visible_idx ON public.learning_exposure_observations USING btree (observation_id) WHERE visible;

CREATE INDEX learning_exposure_work_lease_idx ON public.learning_exposure_work USING btree (lease_until) WHERE (token IS NOT NULL);

CREATE INDEX learning_extraction_benchmark_cases_run_status_idx ON public.learning_extraction_benchmark_cases USING btree (run_id, status, ordinal);

CREATE INDEX learning_extraction_benchmark_runs_started_idx ON public.learning_extraction_benchmark_runs USING btree (started_at DESC);

CREATE INDEX learning_extraction_human_reviews_run_status_idx ON public.learning_extraction_human_reviews USING btree (run_id, status);

CREATE INDEX learning_feedback_traces_pending ON public.learning_feedback_traces USING btree (created_at) WHERE (state = 'pending'::text);

CREATE INDEX learning_hindsight_agy_bridge_experiment_idx ON public.learning_hindsight_agy_bridge_requests USING btree (experiment_id, operation_id, started_at);

CREATE INDEX learning_hindsight_consolidation_trigger_ready_idx ON public.learning_hindsight_consolidation_triggers USING btree (status, next_poll_at);

CREATE INDEX learning_hook_events_model_time_idx ON public.learning_hook_events USING btree (model, occurred_at DESC) WHERE (model IS NOT NULL);

CREATE INDEX learning_hook_events_provider_time_idx ON public.learning_hook_events USING btree (provider, occurred_at DESC);

CREATE INDEX learning_hook_events_thread_time_idx ON public.learning_hook_events USING btree (thread_id, occurred_at DESC);

CREATE INDEX learning_hook_health_events_recent ON public.learning_hook_health_events USING btree (user_id, occurred_at DESC);

CREATE INDEX learning_live_feedback_recent ON public.learning_live_feedback_turns USING btree (user_id, session_id, created_at DESC);

CREATE INDEX learning_outcome_steering_evaluations_status_idx ON public.learning_outcome_steering_evaluations USING btree (status, updated_at DESC);

CREATE INDEX learning_semantic_index_conversation ON public.learning_semantic_index_messages USING btree (conversation_id, observed_at);

CREATE INDEX learning_transcript_archive_scan_idx ON public.learning_transcript_archive_checkpoints USING btree (last_scanned_at NULLS FIRST);

CREATE INDEX learning_turn_context_decisions_created_idx ON public.learning_turn_context_decisions USING btree (created_at DESC);

CREATE INDEX learning_vector_arrivals_pending ON public.learning_vector_arrivals USING btree (created_at, event_id);

CREATE INDEX learning_vector_turn_experiments_owner ON public.learning_vector_turn_experiments USING btree (user_id, created_at DESC);

CREATE INDEX telemetry_outbox_expired ON public.telemetry_outbox USING btree (lease_until) WHERE (state = 'delivering'::text);

CREATE INDEX telemetry_outbox_ready ON public.telemetry_outbox USING btree (available_at, created_at) WHERE (state = 'pending'::text);

CREATE INDEX telemetry_outbox_retention ON public.telemetry_outbox USING btree (updated_at, id) WHERE ((compacted_at IS NULL) AND (state = ANY (ARRAY['delivered'::text, 'dead'::text])));

CREATE TRIGGER learning_archive_blobs_immutable BEFORE DELETE OR UPDATE ON public.learning_archive_blobs FOR EACH ROW EXECUTE FUNCTION public.learning_archive_reject_blob_mutation();

CREATE TRIGGER learning_archive_version_chunks_immutable BEFORE INSERT OR DELETE OR UPDATE ON public.learning_archive_version_chunks FOR EACH ROW EXECUTE FUNCTION public.learning_archive_guard_chunk_mutation();

CREATE TRIGGER learning_archive_versions_immutable BEFORE DELETE OR UPDATE ON public.learning_archive_versions FOR EACH ROW EXECUTE FUNCTION public.learning_archive_guard_version_mutation();

CREATE TRIGGER learning_archive_versions_validate_seal BEFORE UPDATE OF manifest_status ON public.learning_archive_versions FOR EACH ROW EXECUTE FUNCTION public.learning_archive_validate_version_seal();

CREATE TRIGGER learning_assessment_attempt_immutable BEFORE DELETE OR UPDATE ON public.learning_concept_assessment_attempts FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_immutable();

CREATE TRIGGER learning_assessment_receipt_immutable BEFORE DELETE OR UPDATE ON public.learning_concept_assessment_receipts FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_immutable();

CREATE TRIGGER learning_assessment_run_immutable BEFORE DELETE OR UPDATE ON public.learning_concept_assessment_runs FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_immutable();

CREATE TRIGGER learning_playground_attempt_immutable BEFORE DELETE OR UPDATE ON public.learning_playground_response_attempts FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_immutable();

CREATE TRIGGER learning_playground_receipt_immutable BEFORE DELETE OR UPDATE ON public.learning_playground_response_receipts FOR EACH ROW EXECUTE FUNCTION public.learning_assessment_immutable();

CREATE TRIGGER learning_vector_arrival AFTER INSERT OR UPDATE OF status, current_canonical ON public.learning_semantic_index_messages FOR EACH ROW EXECUTE FUNCTION public.learning_record_vector_arrival();

ALTER TABLE ONLY public.learning_archive_checkpoints
    ADD CONSTRAINT learning_archive_checkpoints_last_verified_version_id_fkey FOREIGN KEY (last_verified_version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_archive_checkpoints
    ADD CONSTRAINT learning_archive_checkpoints_last_verified_version_id_sour_fkey FOREIGN KEY (last_verified_version_id, source_id, generation) REFERENCES public.learning_archive_versions(version_id, source_id, generation);

ALTER TABLE ONLY public.learning_archive_checkpoints
    ADD CONSTRAINT learning_archive_checkpoints_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.learning_archive_sources(source_id);

ALTER TABLE ONLY public.learning_archive_errors
    ADD CONSTRAINT learning_archive_errors_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_archive_runs(run_id);

ALTER TABLE ONLY public.learning_archive_errors
    ADD CONSTRAINT learning_archive_errors_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.learning_archive_sources(source_id);

ALTER TABLE ONLY public.learning_archive_errors
    ADD CONSTRAINT learning_archive_errors_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_archive_version_chunks
    ADD CONSTRAINT learning_archive_version_chunks_blob_sha256_fkey FOREIGN KEY (blob_sha256) REFERENCES public.learning_archive_blobs(sha256);

ALTER TABLE ONLY public.learning_archive_version_chunks
    ADD CONSTRAINT learning_archive_version_chunks_version_id_fkey FOREIGN KEY (version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_base_version_id_fkey FOREIGN KEY (base_version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_archive_runs(run_id);

ALTER TABLE ONLY public.learning_archive_versions
    ADD CONSTRAINT learning_archive_versions_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.learning_archive_sources(source_id);

ALTER TABLE ONLY public.learning_concept_assessment_attempts
    ADD CONSTRAINT learning_concept_assessment_attempts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_assessment_runs(run_id);

ALTER TABLE ONLY public.learning_concept_assessment_cache
    ADD CONSTRAINT learning_concept_assessment_cache_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_assessment_runs(run_id);

ALTER TABLE ONLY public.learning_concept_assessment_receipts
    ADD CONSTRAINT learning_concept_assessment_receipts_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_assessment_runs(run_id);

ALTER TABLE ONLY public.learning_concept_edges
    ADD CONSTRAINT learning_concept_edges_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.learning_curricula(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_concept_edges
    ADD CONSTRAINT learning_concept_edges_from_concept_id_fkey FOREIGN KEY (from_concept_id) REFERENCES public.learning_concepts(id);

ALTER TABLE ONLY public.learning_concept_edges
    ADD CONSTRAINT learning_concept_edges_to_concept_id_fkey FOREIGN KEY (to_concept_id) REFERENCES public.learning_concepts(id);

ALTER TABLE ONLY public.learning_concept_tag_budgets
    ADD CONSTRAINT learning_concept_tag_budgets_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_tag_experiments(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_concept_tag_items
    ADD CONSTRAINT learning_concept_tag_items_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_tag_experiments(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_concept_tag_reservations
    ADD CONSTRAINT learning_concept_tag_reservations_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_tag_experiments(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_consolidator_prompt_exports
    ADD CONSTRAINT learning_consolidator_prompt_exports_assessment_run_id_fkey FOREIGN KEY (assessment_run_id) REFERENCES public.learning_concept_assessment_runs(run_id);

ALTER TABLE ONLY public.learning_consolidator_prompt_exports
    ADD CONSTRAINT learning_consolidator_prompt_exports_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES public.learning_consolidator_prompt_experiments(run_id);

ALTER TABLE ONLY public.learning_curriculum_generation_runs
    ADD CONSTRAINT learning_curriculum_generation_runs_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.learning_curricula(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.learning_curriculum_lanes
    ADD CONSTRAINT learning_curriculum_lanes_curriculum_id_fkey FOREIGN KEY (curriculum_id) REFERENCES public.learning_curricula(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_curriculum_module_concepts
    ADD CONSTRAINT learning_curriculum_module_concept_curriculum_id_module_id_fkey FOREIGN KEY (curriculum_id, module_id) REFERENCES public.learning_curriculum_modules(curriculum_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_curriculum_module_concepts
    ADD CONSTRAINT learning_curriculum_module_concepts_concept_id_fkey FOREIGN KEY (concept_id) REFERENCES public.learning_concepts(id);

ALTER TABLE ONLY public.learning_curriculum_module_dependencies
    ADD CONSTRAINT learning_curriculum_module_de_curriculum_id_depends_on_mod_fkey FOREIGN KEY (curriculum_id, depends_on_module_id) REFERENCES public.learning_curriculum_modules(curriculum_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_curriculum_module_dependencies
    ADD CONSTRAINT learning_curriculum_module_depende_curriculum_id_module_id_fkey FOREIGN KEY (curriculum_id, module_id) REFERENCES public.learning_curriculum_modules(curriculum_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_curriculum_modules
    ADD CONSTRAINT learning_curriculum_modules_curriculum_id_lane_id_fkey FOREIGN KEY (curriculum_id, lane_id) REFERENCES public.learning_curriculum_lanes(curriculum_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_curriculum_modules
    ADD CONSTRAINT learning_curriculum_modules_curriculum_id_parent_id_fkey FOREIGN KEY (curriculum_id, parent_id) REFERENCES public.learning_curriculum_modules(curriculum_id, id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY public.learning_curriculum_sources
    ADD CONSTRAINT learning_curriculum_sources_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_curriculum_generation_runs(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_exposure_imports
    ADD CONSTRAINT learning_exposure_imports_raw_version_id_fkey FOREIGN KEY (raw_version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_exposure_observations
    ADD CONSTRAINT learning_exposure_observations_raw_version_id_fkey FOREIGN KEY (raw_version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_exposure_projection_cursors
    ADD CONSTRAINT learning_exposure_projection_cursors_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.learning_archive_sources(source_id);

ALTER TABLE ONLY public.learning_extraction_benchmark_cases
    ADD CONSTRAINT learning_extraction_benchmark_cases_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_extraction_benchmark_runs(run_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_extraction_benchmark_results
    ADD CONSTRAINT learning_extraction_benchmark_results_run_id_case_id_fkey FOREIGN KEY (run_id, case_id) REFERENCES public.learning_extraction_benchmark_cases(run_id, case_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_extraction_human_reviews
    ADD CONSTRAINT learning_extraction_human_reviews_run_id_case_id_fkey FOREIGN KEY (run_id, case_id) REFERENCES public.learning_extraction_benchmark_cases(run_id, case_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_outcome_steering_dimensions
    ADD CONSTRAINT learning_outcome_steering_dimensions_evaluation_id_fkey FOREIGN KEY (evaluation_id) REFERENCES public.learning_outcome_steering_evaluations(evaluation_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_outcome_steering_evaluations
    ADD CONSTRAINT learning_outcome_steering_evaluations_artifact_id_fkey FOREIGN KEY (artifact_id) REFERENCES public.learning_episode_artifacts(artifact_id) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_outcome_steering_evidence
    ADD CONSTRAINT learning_outcome_steering_evidence_evaluation_id_dimension_fkey FOREIGN KEY (evaluation_id, dimension) REFERENCES public.learning_outcome_steering_dimensions(evaluation_id, dimension) ON DELETE CASCADE;

ALTER TABLE ONLY public.learning_playground_response_receipts
    ADD CONSTRAINT learning_playground_response_receipts_request_id_fkey FOREIGN KEY (request_id) REFERENCES public.learning_playground_response_attempts(request_id);

ALTER TABLE ONLY public.learning_reactive_routes
    ADD CONSTRAINT learning_reactive_routes_event_id_fkey FOREIGN KEY (event_id) REFERENCES public.learning_vector_arrivals(event_id);

ALTER TABLE ONLY public.learning_semantic_index_chunks
    ADD CONSTRAINT learning_semantic_index_chunks_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.learning_semantic_index_messages(message_id);

ALTER TABLE ONLY public.learning_semantic_index_members
    ADD CONSTRAINT learning_semantic_index_members_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.learning_semantic_index_messages(message_id);

ALTER TABLE ONLY public.learning_semantic_index_members
    ADD CONSTRAINT learning_semantic_index_members_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_semantic_index_runs(run_id);

ALTER TABLE ONLY public.learning_semantic_index_messages
    ADD CONSTRAINT learning_semantic_index_messages_observation_id_fkey FOREIGN KEY (observation_id) REFERENCES public.learning_exposure_observations(observation_id);

ALTER TABLE ONLY public.learning_semantic_index_messages
    ADD CONSTRAINT learning_semantic_index_messages_raw_version_id_fkey FOREIGN KEY (raw_version_id) REFERENCES public.learning_archive_versions(version_id);

ALTER TABLE ONLY public.learning_vector_turn_assessments
    ADD CONSTRAINT learning_vector_turn_assessments_experiment_id_fkey FOREIGN KEY (experiment_id) REFERENCES public.learning_vector_turn_experiments(run_id);

ALTER TABLE ONLY public.learning_vector_turn_assessments
    ADD CONSTRAINT learning_vector_turn_assessments_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.learning_concept_assessment_runs(run_id);



