/** Test-only draws from a seeded uniform (`seededRandom`), for simulations with a known truth. */
/** Standard normal draws (Box–Muller). */
export const seededNormal = (rand: () => number) => () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand())
/** Laplace draws of sd `sd` (heavier-tailed than the normal). */
export const seededLaplace = (rand: () => number) => (sd: number) => { const u = rand() - 0.5; return -(sd / Math.SQRT2) * Math.sign(u) * Math.log(1 - 2 * Math.abs(u)) }
