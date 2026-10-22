/**
 * The native Hindsight vector bank is a separate database. The previous host
 * derived its URL from the app's own DATABASE_URL by swapping the database
 * name (and refused to run unless the app database had one specific name).
 * Learner takes it explicitly instead: LEARNER_HINDSIGHT_DATABASE_URL, opened
 * read-only by the callers. Granting the Learner role SELECT on that bank is
 * an operator step at cutover.
 */
export function hindsightDatabaseUrl(): string {
  const url = process.env.LEARNER_HINDSIGHT_DATABASE_URL
  if (!url) throw new Error('LEARNER_HINDSIGHT_DATABASE_URL is not configured')
  return url
}

/**
 * The Hindsight install and its model cache. deploy/hindsight/install.sh builds
 * /opt/learner-hindsight from vendor/hindsight. HINDSIGHT_INSTALL_ROOT /
 * LEARNER_HINDSIGHT_CACHE override.
 */
export const hindsightInstallRoot = (): string => process.env.HINDSIGHT_INSTALL_ROOT ?? '/opt/learner-hindsight'
export const hindsightPython = (): string => `${hindsightInstallRoot()}/venv/bin/python`
export const hindsightHfHome = (): string => `${process.env.LEARNER_HINDSIGHT_CACHE ?? '/var/lib/learner-hindsight/cache'}/huggingface`
