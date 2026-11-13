export function envFlag(name: string): boolean {
	const raw = process.env[name];
	if (!raw) return false;
	return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function runtimeEnvironment(): string {
	return process.env.LEARNER_ENV || process.env.APP_ENV || process.env.NODE_ENV || "development";
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
