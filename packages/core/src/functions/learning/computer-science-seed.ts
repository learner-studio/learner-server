import type { LearningGraph } from './learning-seed.js'
import { CURRICULUM_REVISION, practicalComputingSeed } from './practical-computing-seed.js'
import { FOUNDATION_PREREQUISITES } from './computer-science-prerequisites.js'

const PROVENANCE = {
  kind: 'model-seed' as const,
  source: 'OpenAI model-authored conceptual curriculum',
  version: 'cs-2026-09-04.1',
}

type ModuleSeed = {
  id: string
  title: string
  summary: string
  concepts: readonly string[]
  dependsOn?: readonly string[]
}

type LaneSeed = {
  id: string
  title: string
  summary: string
  color: string
  modules: readonly ModuleSeed[]
}

const module = (
  id: string,
  title: string,
  summary: string,
  concepts: readonly string[],
  dependsOn: readonly string[] = [],
): ModuleSeed => ({ id, title, summary, concepts, dependsOn })

/**
 * Original concept definitions and IDs remain unchanged for historical
 * assessment compatibility. Lesson order is navigation, never an inferred
 * prerequisite. Practical additions carry a separate content revision.
 */
const LANE_SEEDS: readonly LaneSeed[] = [
  {
    id: 'data-science',
    title: 'Data Science',
    summary: 'Turn observations into defensible decisions while preserving uncertainty, causality, and provenance.',
    color: '#d99062',
    modules: [
      module('ds-question-framing', 'Questions, decisions, and estimands', 'Translate a vague business or scientific question into a decision and a quantity the data can actually inform.', ['Decision context', 'Unit of analysis', 'Target quantity', 'Estimand', 'Data-generating process'], ['foundations-systems-thinking']),
      module('ds-data-lifecycle', 'The data lifecycle', 'Reason from how observations are created through how they change, move, and eventually expire.', ['Data collection', 'Data provenance', 'Data lineage', 'Schema drift', 'Data retention'], ['data-data-models']),
      module('ds-measurement', 'Measurement and operationalization', 'Distinguish a real-world construct from the imperfect observations used to represent it.', ['Construct', 'Operational definition', 'Measurement reliability', 'Measurement validity', 'Proxy variable'], ['ds-question-framing', 'math-probability']),
      module('ds-sampling', 'Populations and sampling', 'Explain when observed cases represent a target population and why more rows do not cure biased selection.', ['Target population', 'Sampling frame', 'Random sample', 'Selection bias', 'External validity'], ['ds-measurement', 'math-probability']),
      module('ds-eda', 'Exploratory data analysis', 'See distributions, subgroups, anomalies, and missingness before compressing observations into a model.', ['Distribution shape', 'Central tendency', 'Dispersion', 'Outlier', 'Stratification'], ['ds-sampling']),
      module('ds-missing-data', 'Missingness and data quality', 'Treat absent, corrupted, duplicated, and censored values as evidence about the generating process.', ['Missing completely at random', 'Missing at random', 'Informative missingness', 'Censoring', 'Data quality dimension'], ['ds-eda']),
      module('ds-probabilistic-reasoning', 'Probability as uncertainty', 'Represent uncertain outcomes and update beliefs when new evidence arrives.', ['Random variable', 'Conditional probability', 'Bayes rule', 'Expected value', 'Variance'], ['math-probability', 'ds-eda']),
      module('ds-statistical-inference', 'Statistical inference', 'Connect a finite sample to uncertain claims about a population without treating a statistic as truth.', ['Estimator', 'Sampling distribution', 'Confidence interval', 'Hypothesis test', 'P-value'], ['ds-probabilistic-reasoning']),
      module('ds-causal-reasoning', 'Causal reasoning', 'Separate association from intervention by making assumptions about the causal system visible.', ['Causal graph', 'Confounder', 'Collider', 'Intervention', 'Counterfactual'], ['ds-statistical-inference', 'foundations-models']),
      module('ds-experiments', 'Randomized experiments', 'Understand why random assignment supports causal comparison and where experiments still fail.', ['Random assignment', 'Control group', 'Statistical power', 'Effect size', 'Interference'], ['ds-causal-reasoning']),
      module('ds-observational-causality', 'Causality from observational data', 'Evaluate quasi-experimental strategies by the assumptions that make their comparisons credible.', ['Matching', 'Propensity score', 'Instrumental variable', 'Difference in differences', 'Regression discontinuity'], ['ds-experiments']),
      module('ds-representation', 'Features and representation', 'Choose a grain and encoding that preserve the signal needed for the question without leaking the answer.', ['Observation grain', 'Feature', 'Categorical encoding', 'Target leakage', 'Dimensionality'], ['ds-data-lifecycle', 'programming-data-abstractions']),
      module('ds-modeling', 'Models, loss, and generalization', 'See a fitted model as a constrained approximation optimized for an explicit error tradeoff.', ['Baseline model', 'Loss function', 'Bias-variance tradeoff', 'Regularization', 'Calibration'], ['ds-representation', 'ds-probabilistic-reasoning']),
      module('ds-evaluation', 'Evaluation and validation', 'Estimate future usefulness with honest holdouts, task-aligned metrics, and explicit operating thresholds.', ['Train-validation-test split', 'Cross-validation', 'Evaluation metric', 'Decision threshold', 'Distribution shift'], ['ds-modeling']),
      module('ds-communication', 'Visualization and decision communication', 'Make the chain from evidence to recommendation inspectable, reproducible, and honest about uncertainty.', ['Visual encoding', 'Uncertainty communication', 'Data narrative', 'Reproducible analysis', 'Decision memo'], ['ds-evaluation', 'hci-information-design']),
      module('ds-production', 'Data products in production', 'Reason about the living feedback system created when a model begins influencing the data it later observes.', ['Batch scoring', 'Streaming inference', 'Data drift', 'Concept drift', 'Feedback loop'], ['ds-evaluation', 'delivery-observability', 'architecture-event-systems']),
    ],
  },
  {
    id: 'foundations',
    title: 'Computing Foundations',
    summary: 'The durable mental models underneath every computing specialty.',
    color: '#6c8ebf',
    modules: [
      module('foundations-abstraction', 'Abstraction and boundaries', 'Control complexity by deciding which details a model exposes and which it deliberately hides.', ['Abstraction', 'Interface boundary', 'Encapsulation', 'Implementation detail', 'Leaky abstraction']),
      module('foundations-information', 'Information and representation', 'Understand how symbols, bits, encodings, and compression represent meaning without being the meaning.', ['Bit', 'Encoding', 'Information entropy', 'Lossless compression', 'Lossy compression']),
      module('foundations-computation', 'Computation as state transformation', 'Model a computation as rules that transform represented state through time.', ['State', 'Transition', 'Input', 'Output', 'Invariant'], ['foundations-abstraction']),
      module('foundations-decomposition', 'Decomposition and composition', 'Break problems into parts whose contracts permit them to be understood and recombined.', ['Problem decomposition', 'Composition', 'Separation of concerns', 'Coupling', 'Cohesion'], ['foundations-abstraction']),
      module('foundations-models', 'Models and reality', 'Use models as purposeful simplifications and identify the conditions under which their predictions stop working.', ['Mental model', 'Assumption', 'Approximation', 'Model validity', 'Model failure']),
      module('foundations-systems-thinking', 'Systems and feedback', 'Reason about interacting components, delayed effects, bottlenecks, and emergent behavior.', ['System boundary', 'Feedback loop', 'Emergence', 'Bottleneck', 'Tradeoff'], ['foundations-computation', 'foundations-models']),
    ],
  },
  {
    id: 'mathematics',
    title: 'Mathematical Foundations',
    summary: 'Language for structure, uncertainty, change, proof, and optimization.',
    color: '#8e7cc3',
    modules: [
      module('math-logic-proof', 'Logic and proof', 'Evaluate whether conclusions follow from premises and distinguish examples from general arguments.', ['Proposition', 'Logical implication', 'Quantifier', 'Proof by induction', 'Proof by contradiction'], ['foundations-models']),
      module('math-discrete-structures', 'Discrete structures', 'Model countable objects and the relationships that organize them.', ['Set', 'Relation', 'Function mapping', 'Combinatorial counting', 'Recurrence relation'], ['math-logic-proof']),
      module('math-probability', 'Probability foundations', 'Quantify uncertainty over events and reason about dependence.', ['Sample space', 'Probability distribution', 'Independence', 'Conditional dependence', 'Bayesian update'], ['math-discrete-structures']),
      module('math-linear-algebra', 'Linear algebra and geometry', 'Represent many interacting quantities as vectors and transformations in geometric spaces.', ['Vector', 'Matrix', 'Linear transformation', 'Basis', 'Eigenvector'], ['math-discrete-structures']),
      module('math-calculus', 'Change and accumulation', 'Connect local rates of change to accumulated effects over a continuous space.', ['Limit', 'Derivative', 'Gradient', 'Integral', 'Chain rule'], ['math-discrete-structures']),
      module('math-inference', 'Optimization and numerical reasoning', 'Find useful approximate solutions while accounting for objective shape, conditioning, and finite precision.', ['Objective function', 'Convexity', 'Gradient descent', 'Numerical stability', 'Approximation error'], ['math-linear-algebra', 'math-calculus']),
    ],
  },
  {
    id: 'programming',
    title: 'Programming and Software Construction',
    summary: 'Express behavior precisely and build changeable programs from understandable parts.',
    color: '#3d85c6',
    modules: [
      module('programming-execution-model', 'Execution, state, and control flow', 'Trace what a program can observe, change, and do next without relying on surface syntax.', ['Variable binding', 'Mutable state', 'Control flow', 'Call stack', 'Evaluation order'], ['foundations-computation']),
      module('programming-data-abstractions', 'Types and data abstractions', 'Use representations and invariants to make invalid states harder to express.', ['Data type', 'Algebraic data type', 'Object identity', 'Value semantics', 'Representation invariant'], ['programming-execution-model', 'foundations-information']),
      module('programming-functions-interfaces', 'Functions, modules, and interfaces', 'Compose behavior through contracts that separate what a component promises from how it works.', ['Pure function', 'Side effect', 'Module', 'Application programming interface', 'Dependency injection'], ['programming-data-abstractions', 'foundations-decomposition']),
      module('programming-errors-tests', 'Errors, testing, and debugging', 'Turn surprising behavior into localized hypotheses and evidence about violated expectations.', ['Failure mode', 'Exception', 'Test oracle', 'Test double', 'Debugging hypothesis'], ['programming-functions-interfaces']),
      module('programming-language-models', 'Programming language models', 'Compare paradigms by how they represent state, control, composition, and effects.', ['Imperative paradigm', 'Functional paradigm', 'Object-oriented paradigm', 'Declarative paradigm', 'Type system'], ['programming-functions-interfaces']),
      module('programming-runtimes-concurrency', 'Runtimes and concurrency', 'Reason about lifetimes, scheduling, shared state, and nondeterminism across simultaneous work.', ['Runtime', 'Garbage collection', 'Process', 'Thread', 'Race condition'], ['programming-errors-tests', 'programming-language-models']),
    ],
  },
  {
    id: 'algorithms',
    title: 'Algorithms and Computation',
    summary: 'Understand what procedures compute, how their costs grow, and what cannot be computed efficiently or at all.',
    color: '#674ea7',
    modules: [
      module('algorithms-complexity', 'Growth and complexity', 'Compare resource use by how it scales with input rather than by one benchmark.', ['Input size', 'Asymptotic growth', 'Time complexity', 'Space complexity', 'Amortized analysis'], ['math-discrete-structures', 'programming-execution-model']),
      module('algorithms-data-structures', 'Data structures', 'Choose representations whose operations align with the access patterns a problem requires.', ['Array', 'Linked structure', 'Hash table', 'Tree structure', 'Heap'], ['algorithms-complexity', 'programming-data-abstractions']),
      module('algorithms-design', 'Algorithm design paradigms', 'Recognize reusable strategies for reducing, decomposing, and searching problem spaces.', ['Divide and conquer', 'Dynamic programming', 'Greedy choice', 'Backtracking', 'Randomized algorithm'], ['algorithms-data-structures']),
      module('algorithms-graphs', 'Graph algorithms', 'Model connected entities and reason about reachability, paths, flow, and ordering.', ['Graph', 'Graph traversal', 'Shortest path', 'Topological order', 'Network flow'], ['algorithms-design']),
      module('algorithms-optimization', 'Search and optimization', 'Navigate large solution spaces using exact, approximate, and heuristic methods.', ['Search space', 'Constraint satisfaction', 'Local optimum', 'Heuristic', 'Approximation algorithm'], ['algorithms-design', 'math-inference']),
      module('algorithms-computability', 'Computability and limits', 'Distinguish problems with algorithms from undecidable problems and tractable problems from intractable ones.', ['Formal language', 'Automaton', 'Turing machine', 'Decidability', 'NP-completeness'], ['algorithms-complexity', 'math-logic-proof']),
    ],
  },
  {
    id: 'systems',
    title: 'Computer Systems',
    summary: 'Connect digital hardware, operating systems, memory, storage, and performance into one execution model.',
    color: '#45818e',
    modules: [
      module('systems-digital-logic', 'Digital logic', 'See reliable digital behavior emerge from physical signals and composable logic.', ['Boolean gate', 'Combinational circuit', 'Sequential circuit', 'Clock', 'Finite-state machine'], ['foundations-information', 'math-logic-proof']),
      module('systems-architecture', 'Processor architecture', 'Trace instructions through computation, memory access, and control inside a machine.', ['Instruction set architecture', 'Register', 'Arithmetic logic unit', 'Pipeline', 'Branch prediction'], ['systems-digital-logic', 'programming-execution-model']),
      module('systems-operating-systems', 'Operating systems', 'Understand how the kernel multiplexes hardware while isolating and coordinating programs.', ['Kernel', 'System call', 'Virtual memory', 'Scheduler', 'File descriptor'], ['systems-architecture', 'programming-runtimes-concurrency']),
      module('systems-memory-storage', 'Memory and storage hierarchy', 'Predict latency and persistence by following data through caches, memory, and durable media.', ['Memory hierarchy', 'CPU cache', 'Locality', 'Persistent storage', 'File system'], ['systems-architecture']),
      module('systems-io-virtualization', 'I/O and virtualization', 'Reason about devices, interrupts, isolation, and the layers that make one machine appear as many.', ['Input-output device', 'Interrupt', 'Device driver', 'Virtual machine', 'Container isolation'], ['systems-operating-systems']),
      module('systems-performance', 'Systems performance', 'Locate throughput and latency limits with measurement, queueing, parallelism, and resource accounting.', ['Latency', 'Throughput', 'Queueing delay', 'Parallel speedup', 'Performance counter'], ['systems-memory-storage', 'systems-io-virtualization']),
    ],
  },
  {
    id: 'architecture',
    title: 'Software Architecture',
    summary: 'Shape boundaries, state, communication, and evolution across larger software systems.',
    color: '#76a5af',
    modules: [
      module('architecture-modularity', 'Modularity at scale', 'Partition a system so teams and components can change with bounded coordination.', ['Architectural boundary', 'Component responsibility', 'Dependency direction', 'Information hiding', 'Change coupling'], ['foundations-decomposition', 'programming-functions-interfaces']),
      module('architecture-contracts', 'Contracts and compatibility', 'Treat APIs and schemas as promises that must evolve without surprising consumers.', ['Interface contract', 'Precondition', 'Postcondition', 'Backward compatibility', 'Semantic versioning'], ['architecture-modularity']),
      module('architecture-styles', 'Architectural styles', 'Compare layered, modular, service-oriented, and peer-to-peer structures by their tradeoffs.', ['Layered architecture', 'Modular monolith', 'Service architecture', 'Peer-to-peer architecture', 'Hexagonal architecture'], ['architecture-contracts']),
      module('architecture-state', 'State and consistency boundaries', 'Decide where truth lives and what consistency different interactions actually require.', ['Source of truth', 'State ownership', 'Consistency boundary', 'Cache invalidation', 'Derived state'], ['architecture-modularity', 'data-transactions']),
      module('architecture-event-systems', 'Events, messages, and workflows', 'Model asynchronous work through delivery guarantees, ordering, idempotency, and orchestration.', ['Event', 'Message queue', 'Delivery guarantee', 'Idempotency', 'Workflow orchestration'], ['architecture-state', 'programming-runtimes-concurrency']),
      module('architecture-evolution', 'Evolution and tradeoff records', 'Make architectural decisions revisable by preserving forces, constraints, and migration paths.', ['Quality attribute', 'Architecture tradeoff', 'Decision record', 'Technical debt', 'Strangler migration'], ['architecture-styles', 'architecture-event-systems']),
    ],
  },
  {
    id: 'networks',
    title: 'Networking and Distributed Systems',
    summary: 'Reason about communication when messages are delayed, reordered, duplicated, lost, or split by failure.',
    color: '#6aa84f',
    modules: [
      module('networks-packets-layers', 'Packets and layers', 'Understand how layered protocols move bounded messages across heterogeneous links.', ['Network packet', 'Protocol layer', 'Encapsulation header', 'Maximum transmission unit', 'Packet switching'], ['foundations-information']),
      module('networks-addressing-routing', 'Addressing and routing', 'Trace how names and addresses identify destinations and how networks choose paths.', ['MAC address', 'IP address', 'Subnet', 'Router', 'Domain name system'], ['networks-packets-layers']),
      module('networks-transport', 'Transport behavior', 'Compare reliability, ordering, congestion control, and latency at the end-to-end transport layer.', ['Port', 'TCP connection', 'UDP datagram', 'Congestion control', 'Flow control'], ['networks-addressing-routing']),
      module('networks-application', 'Application protocols', 'Read application interactions as protocol state machines with explicit semantics and caching.', ['HTTP semantics', 'TLS channel', 'Remote procedure call', 'WebSocket session', 'Content delivery network'], ['networks-transport', 'architecture-contracts']),
      module('networks-distributed-model', 'Distributed-system model', 'Assume partial failure and uncertain time rather than extending single-machine intuition across a network.', ['Partial failure', 'Network partition', 'Failure detector', 'Logical clock', 'CAP tradeoff'], ['networks-application', 'foundations-systems-thinking']),
      module('networks-coordination', 'Replication and coordination', 'Reason about replicated truth, ordering, consensus, and convergence under failure.', ['Replication', 'Quorum', 'Consensus', 'Leader election', 'Conflict-free replicated data type'], ['networks-distributed-model', 'algorithms-graphs']),
    ],
  },
  {
    id: 'data-databases',
    title: 'Data and Databases',
    summary: 'Model durable information and understand the guarantees and costs behind queries and transactions.',
    color: '#38761d',
    modules: [
      module('data-data-models', 'Data models and schemas', 'Represent entities, relationships, events, and constraints in a form that answers intended questions.', ['Entity', 'Attribute', 'Relationship', 'Schema', 'Data constraint'], ['foundations-information', 'programming-data-abstractions']),
      module('data-relational', 'Relational reasoning', 'See tables as relations and queries as transformations over sets of facts.', ['Relation', 'Primary key', 'Foreign key', 'Normalization', 'Relational algebra'], ['data-data-models', 'math-discrete-structures']),
      module('data-query-processing', 'Query processing', 'Trace a declarative query through planning, operators, cardinality estimates, and execution.', ['Query plan', 'Scan operator', 'Join algorithm', 'Cardinality estimate', 'Cost model'], ['data-relational', 'algorithms-complexity']),
      module('data-transactions', 'Transactions and concurrency', 'Understand which anomalies a database prevents and what isolation costs.', ['Atomic transaction', 'Consistency invariant', 'Isolation level', 'Durability', 'Serialization anomaly'], ['data-relational', 'programming-runtimes-concurrency']),
      module('data-storage-indexes', 'Storage and indexing', 'Predict read and write costs from page layout, indexes, logs, and access patterns.', ['Database page', 'B-tree index', 'Log-structured storage', 'Write-ahead log', 'Query access pattern'], ['data-query-processing', 'systems-memory-storage']),
      module('data-analytical-systems', 'Analytical and streaming systems', 'Compare operational, analytical, lake, warehouse, and stream representations by latency and consistency needs.', ['Online transaction processing', 'Online analytical processing', 'Data warehouse', 'Data lake', 'Stream processing'], ['data-transactions', 'data-storage-indexes', 'architecture-event-systems']),
    ],
  },
  {
    id: 'ai-ml',
    title: 'Artificial Intelligence and Machine Learning',
    summary: 'Understand learning systems as optimization, representation, inference, and evaluation under uncertainty.',
    color: '#c27ba0',
    modules: [
      module('ai-learning-paradigms', 'Learning paradigms', 'Compare supervised, unsupervised, self-supervised, and reinforcement learning by their feedback signal.', ['Training example', 'Label', 'Latent structure', 'Reward signal', 'Inductive bias'], ['ds-modeling']),
      module('ai-supervised', 'Supervised prediction', 'Reason about classification and regression as conditional prediction under a chosen loss.', ['Regression task', 'Classification task', 'Decision boundary', 'Class imbalance', 'Probability calibration'], ['ai-learning-paradigms', 'ds-evaluation']),
      module('ai-unsupervised', 'Unsupervised representation', 'Find useful structure without labels while resisting the urge to treat every pattern as meaning.', ['Clustering', 'Dimensionality reduction', 'Density estimation', 'Latent variable', 'Representation learning'], ['ai-learning-paradigms', 'math-linear-algebra']),
      module('ai-neural-networks', 'Neural networks', 'Understand layered differentiable functions, learned representations, and optimization dynamics.', ['Artificial neuron', 'Activation function', 'Backpropagation', 'Embedding', 'Attention mechanism'], ['ai-supervised', 'math-inference']),
      module('ai-generative-models', 'Generative and foundation models', 'Model how systems learn distributions, condition generation, use context, and fail under mismatch.', ['Generative model', 'Tokenization', 'Pretraining', 'In-context learning', 'Hallucination'], ['ai-neural-networks', 'ai-unsupervised']),
      module('ai-agents-governance', 'Agents, evaluation, and governance', 'Evaluate AI as a sociotechnical system whose tools, autonomy, feedback, and impacts require controls.', ['Tool-using agent', 'Planning loop', 'Model evaluation', 'Alignment objective', 'Human oversight'], ['ai-generative-models', 'security-threat-modeling', 'professional-ethics']),
    ],
  },
  {
    id: 'security-privacy',
    title: 'Security and Privacy',
    summary: 'Protect assets by reasoning explicitly about adversaries, trust boundaries, failure modes, and data rights.',
    color: '#cc0000',
    modules: [
      module('security-threat-modeling', 'Threat modeling', 'Identify assets, adversaries, entry points, and trust assumptions before selecting controls.', ['Asset', 'Threat actor', 'Attack surface', 'Trust boundary', 'Abuse case'], ['foundations-systems-thinking', 'architecture-modularity']),
      module('security-cryptography', 'Cryptographic mental models', 'Know what encryption, hashing, signatures, and key exchange guarantee—and what they do not.', ['Encryption', 'Cryptographic hash', 'Digital signature', 'Key exchange', 'Nonce'], ['security-threat-modeling', 'math-discrete-structures']),
      module('security-identity-access', 'Identity and access control', 'Separate identity proof, session continuity, authorization, and accountability.', ['Authentication', 'Authorization', 'Principal', 'Session', 'Least privilege'], ['security-threat-modeling', 'architecture-contracts']),
      module('security-application', 'Application security', 'Trace how untrusted input crosses boundaries and becomes injection, forgery, disclosure, or confused authority.', ['Input validation', 'Injection attack', 'Cross-site scripting', 'Request forgery', 'Confused deputy'], ['security-identity-access', 'programming-errors-tests', 'networks-application']),
      module('security-infrastructure', 'Infrastructure and supply-chain security', 'Reason about patching, isolation, secrets, dependencies, and compromise containment.', ['Vulnerability', 'Security patch', 'Secret management', 'Software supply chain', 'Defense in depth'], ['security-application', 'systems-io-virtualization']),
      module('security-privacy', 'Privacy engineering', 'Model personal-data flows, intended purposes, inference risks, and meaningful user control.', ['Personal data', 'Data minimization', 'Purpose limitation', 'Anonymization risk', 'Differential privacy'], ['security-cryptography', 'ds-data-lifecycle']),
    ],
  },
  {
    id: 'hci',
    title: 'Human-Computer Interaction',
    summary: 'Design systems around human perception, goals, limitations, context, and diverse forms of access.',
    color: '#e69138',
    modules: [
      module('hci-cognition', 'Human cognition and perception', 'Design for limited attention, working memory, learned expectations, and perceptual grouping.', ['Attention', 'Working memory', 'Mental workload', 'Affordance', 'Gestalt grouping'], ['foundations-models']),
      module('hci-interaction-design', 'Interaction and feedback', 'Make actions discoverable, consequences visible, errors recoverable, and system state understandable.', ['Interaction loop', 'System feedback', 'Mapping', 'Error recovery', 'Progressive disclosure'], ['hci-cognition', 'foundations-abstraction']),
      module('hci-user-research', 'User research', 'Distinguish stated preference from observed behavior and turn qualitative evidence into testable design claims.', ['Research question', 'Interview bias', 'Contextual inquiry', 'Usability test', 'Thematic synthesis'], ['hci-interaction-design', 'professional-problem-framing']),
      module('hci-accessibility', 'Accessibility and inclusive design', 'Treat access needs as core system constraints across perception, motion, cognition, language, and technology.', ['Assistive technology', 'Semantic structure', 'Keyboard access', 'Color contrast', 'Cognitive accessibility'], ['hci-interaction-design']),
      module('hci-information-design', 'Information and visual design', 'Use hierarchy, encoding, layout, and annotation to make structure and uncertainty legible.', ['Visual hierarchy', 'Visual encoding channel', 'Cognitive grouping', 'Annotation', 'Responsive layout'], ['hci-cognition', 'foundations-information']),
      module('hci-collaboration', 'Social and collaborative systems', 'Reason about identity, norms, moderation, awareness, and power when software mediates groups.', ['Social presence', 'Shared context', 'Reputation system', 'Content moderation', 'Dark pattern'], ['hci-user-research', 'security-privacy']),
    ],
  },
  {
    id: 'delivery',
    title: 'Software Delivery and Reliability',
    summary: 'Move changes from idea to dependable operation through evidence, automation, observability, and learning.',
    color: '#f1c232',
    modules: [
      module('delivery-version-control', 'Version control and integration', 'Understand commits, branches, merges, and review as coordination over evolving state.', ['Repository', 'Commit', 'Branch', 'Merge conflict', 'Code review'], ['programming-errors-tests']),
      module('delivery-build-release', 'Build and release systems', 'Trace source through reproducible artifacts, environments, migrations, and controlled rollout.', ['Build artifact', 'Dependency lockfile', 'Continuous integration', 'Deployment environment', 'Release strategy'], ['delivery-version-control', 'architecture-contracts']),
      module('delivery-testing', 'Testing strategy', 'Allocate evidence across fast local checks, integration boundaries, system behavior, and real-world monitoring.', ['Unit test', 'Integration test', 'End-to-end test', 'Contract test', 'Test pyramid'], ['programming-errors-tests']),
      module('delivery-reliability', 'Reliability engineering', 'Manage failure using service objectives, redundancy, capacity, graceful degradation, and recovery.', ['Service-level objective', 'Error budget', 'Redundancy', 'Graceful degradation', 'Disaster recovery'], ['delivery-build-release', 'systems-performance', 'networks-distributed-model']),
      module('delivery-observability', 'Observability and diagnosis', 'Infer internal system state from structured signals and causal investigation.', ['Log event', 'Metric', 'Distributed trace', 'Alert', 'Incident hypothesis'], ['programming-errors-tests']),
      module('delivery-learning-systems', 'Operational learning and change safety', 'Improve systems through blameless analysis, small reversible changes, and explicit socio-technical feedback.', ['Incident', 'Postmortem', 'Change failure rate', 'Rollback', 'Blameless culture'], ['delivery-observability', 'professional-collaboration']),
    ],
  },
  {
    id: 'professional-societal',
    title: 'Professional and Societal Practice',
    summary: 'Build the judgment to connect technical choices with people, organizations, economics, and public consequences.',
    color: '#999999',
    modules: [
      module('professional-problem-framing', 'Requirements and problem framing', 'Separate a requested solution from the underlying need, constraints, stakeholders, and success criteria.', ['Stakeholder', 'User need', 'Requirement', 'Constraint', 'Success criterion'], ['foundations-models']),
      module('professional-product', 'Product and value reasoning', 'Connect user outcomes, organizational goals, opportunity cost, and evidence without confusing output with impact.', ['Value proposition', 'Opportunity cost', 'Product outcome', 'Adoption friction', 'Product experiment'], ['professional-problem-framing', 'hci-user-research']),
      module('professional-ethics', 'Ethics and responsible computing', 'Evaluate who benefits, who bears risk, what rights are affected, and which harms are reversible.', ['Stakeholder impact', 'Algorithmic bias', 'Accountability', 'Informed consent', 'Precautionary principle'], ['professional-problem-framing', 'security-privacy']),
      module('professional-economics', 'Economics of computing', 'Reason about fixed and marginal cost, incentives, externalities, platforms, and scarce attention.', ['Fixed cost', 'Marginal cost', 'Network effect', 'Externality', 'Incentive compatibility'], ['professional-product', 'foundations-systems-thinking']),
      module('professional-communication', 'Technical communication', 'Adapt explanations and decisions to audience, evidence, uncertainty, and action.', ['Audience model', 'Conceptual explanation', 'Technical argument', 'Decision rationale', 'Uncertainty statement'], ['professional-problem-framing', 'hci-information-design']),
      module('professional-collaboration', 'Teams and professional growth', 'Treat software work as coordination, review, ownership, feedback, and deliberate learning.', ['Team topology', 'Ownership boundary', 'Feedback culture', 'Mentorship', 'Deliberate practice'], ['professional-communication', 'architecture-evolution']),
    ],
  },
]

const slug = (value: string): string => value
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-|-$/g, '')

const legacyLanes = LANE_SEEDS.map((lane, laneIndex) => ({
  id: lane.id,
  title: lane.title,
  summary: lane.summary,
  order: laneIndex + 1,
  color: lane.color,
  provenance: PROVENANCE,
}))

const legacyModules = LANE_SEEDS.flatMap((lane, laneIndex) => lane.modules.map((seed, moduleIndex) => {
  return {
    id: seed.id,
    step: laneIndex === 0 ? moduleIndex + 1 : 17 + ((laneIndex - 1) * 6) + moduleIndex,
    title: seed.title,
    summary: seed.summary,
    laneId: lane.id,
    conceptIds: seed.concepts.map((title) => `${seed.id}--${slug(title)}`),
    parentId: null,
    dependsOnModuleIds: [...new Set(seed.dependsOn ?? [])],
    masteryGoals: [
      `Explain ${seed.title.toLowerCase()} as a connected mental model, including its assumptions and boundaries.`,
      `Compare competing cases and predict how ${seed.title.toLowerCase()} changes when its assumptions or inputs change.`,
    ],
    provenance: CURRICULUM_REVISION,
  }
}))

const legacyConcepts = LANE_SEEDS.flatMap((lane, laneIndex) => lane.modules.flatMap((seed, moduleIndex) =>
  seed.concepts.map((title, conceptIndex) => ({
    id: `${seed.id}--${slug(title)}`,
    title,
    summary: `${title} is one atomic part of the ${seed.title.toLowerCase()} mental model.`,
    explanation:
      `${title} is one mechanism or distinction in this module: ${seed.summary} ` +
      'Mastery means knowing the mechanism, its assumptions, the observations it predicts, and the boundary where it stops being useful.',
    example:
      `Use ${title.toLowerCase()} to diagnose a concrete case, compare two plausible explanations, and predict what evidence would distinguish them.`,
    domain: lane.id,
    capability: ['explain', 'predict', 'compare', 'diagnose', 'design'][conceptIndex]!,
    provenance: PROVENANCE,
    x: 120 + (laneIndex * 170) + ((conceptIndex % 2) * 70),
    y: 90 + (moduleIndex * 145) + (conceptIndex * 18),
  })),
))

const practical = practicalComputingSeed(legacyModules.length + 1, legacyLanes.length + 1)
const lanes = [...legacyLanes, ...practical.lanes]
const modules = [...legacyModules, ...practical.modules]
const concepts = [...legacyConcepts, ...practical.concepts]
// Co-membership supplies navigable related edges only. No list position or
// display order can create a hard prerequisite. Explicit concept edges below
// are pedagogical dependencies; module dependencies organize whole lessons.
const related: LearningGraph['edges'] = modules.flatMap((item) => item.conceptIds.length < 2 ? [] : item.conceptIds.map((from, index) => ({
  from, to: item.conceptIds[(index + 1) % item.conceptIds.length]!,
  kind: 'related' as const, confidence: 0.65, provenance: CURRICULUM_REVISION,
})))
const explicit: LearningGraph['edges'] = FOUNDATION_PREREQUISITES.map(([from, to]) => ({
  from, to, kind: 'hard-prerequisite', confidence: 0.9, provenance: CURRICULUM_REVISION,
}))
const edges = [...new Map([...related, ...explicit, ...practical.edges].map((edge) => [`${edge.from}:${edge.to}:${edge.kind}`, edge])).values()]

export const COMPUTER_SCIENCE: LearningGraph = {
  curriculum: {
    id: 'computer-science',
    title: 'Computer Science',
    description:
      'A dependency-aware map of computing, from practical HTML, CSS, programming and debugging to data science, systems, durable workflows and language-model collaboration. Data Science remains the first applied lane; explicit foundations support parallel learning without treating display order as a prerequisite.',
    status: 'seed',
    domain: 'computer-science',
    provenance: CURRICULUM_REVISION,
    lanes,
    modules,
  },
  concepts,
  edges,
}

export const LEARNING_CURRICULA: readonly LearningGraph[] = [COMPUTER_SCIENCE]
