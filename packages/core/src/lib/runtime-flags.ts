export function envFlag(name: string): boolean {
	const raw = process.env[name];
	if (!raw) return false;
	return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function runtimeEnvironment(): string {
	return process.env.LEARNER_ENV || process.env.APP_ENV || process.env.NODE_ENV || "development";
}

export function scheduledJobsDisabled(): boolean {
	return envFlag("DISABLE_SCHEDULED_JOBS");
}

/** `ENABLE_SCHEDULED_JOBS` (comma-separated `wireScheduler` names, whole-name match) re-enables one job under `DISABLE_SCHEDULED_JOBS`. */
export function scheduledJobEnabled(name: string): boolean {
	if (!scheduledJobsDisabled()) return true;
	return (process.env.ENABLE_SCHEDULED_JOBS ?? "").split(",").map((entry) => entry.trim()).includes(name);
}

export function backgroundWorkersDisabled(): boolean {
	return envFlag("DISABLE_BACKGROUND_WORKERS");
}

export function webhookWorkerDisabled(): boolean {
	return envFlag("DISABLE_WEBHOOK_WORKER") || backgroundWorkersDisabled();
}

export function outboundSendsDisabled(): boolean {
	return envFlag("DISABLE_OUTBOUND_SENDS");
}

/**
 * The Learning MVP reads this operator's local transcript stores. Its code may
 * ship in a production artifact, but it is inert unless the host opts in.
 */
export function learningLocalMvpEnabled(): boolean {
	return envFlag("LEARNING_LOCAL_MVP_ENABLED") && !/^prod(?:uction)?$/i.test(runtimeEnvironment());
}

export function assertLearningLocalMvpEnabled(): void {
	if (!learningLocalMvpEnabled()) {
		throw new Error("Learning local MVP is disabled on this host");
	}
}

/** Independent opt-in: never coupled to the application's global scheduler flag. */
export function learningTranscriptArchiveScheduleEnabled(): boolean {
	return learningLocalMvpEnabled() && envFlag("LEARNING_TRANSCRIPT_ARCHIVE_SCHEDULE_ENABLED");
}
