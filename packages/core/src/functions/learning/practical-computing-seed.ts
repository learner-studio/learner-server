import type { LearningGraph } from './learning-seed.js'

export const CURRICULUM_REVISION = {
  kind: 'model-seed' as const,
  source: 'OpenAI Astra adversarial curriculum review',
  version: 'cs-2026-09-06.2',
}

type Concept = { title: string; summary: string; example: string; requires: readonly string[] }
type Lesson = {
  id: string; laneId: string; title: string; summary: string
  concepts: readonly Concept[]; dependsOn: readonly string[]; shared: readonly string[]
}
const concept = (title: string, summary: string, example: string, requires: readonly string[] = []): Concept => ({ title, summary, example, requires })
const lesson = (laneId: string, id: string, title: string, summary: string, concepts: readonly Concept[], dependsOn: readonly string[] = [], shared: readonly string[] = []): Lesson => ({ laneId, id, title, summary, concepts, dependsOn, shared })
const idFor = (lessonId: string, title: string): string => `${lessonId}--${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`

const LANES = [
  ['frontend-web', 'Frontend and the Web', 'Build and explain documents, layout, interactive state, and accessible browser behavior.', '#5c7cfa'],
  ['developer-practice', 'Everyday Programming and Debugging', 'Read code, inspect a running program, make reversible changes, and prove behavior.', '#20c997'],
  ['web-apis', 'Practical APIs and Networking', 'Follow a real request across URLs, HTTP, browser policy, validation, and persistence.', '#51cf66'],
  ['durable-workflows', 'Durable Work and Recovery', 'Make asynchronous work observable, replayable, bounded, and safe across failure.', '#fcc419'],
  ['llm-collaboration', 'Working with Language Models', 'Specify intent, supply context, steer implementation, and evaluate evidence without confusing output with understanding.', '#da77f2'],
] as const

// Lesson size follows one teachable question. Shared concepts refer to existing
// IDs; they do not create another assessment for the same underlying concept.
const LESSONS: readonly Lesson[] = [
  lesson('frontend-web', 'web-html', 'HTML elements and document structure', 'Explain what the browser parses and choose elements that express the meaning of a document.', [
    concept('HTML element', 'An HTML element gives a piece of document content a structure and meaning; tags delimit it in markup.', 'Compare <p>Hello</p> with the plain string Hello.'),
    concept('HTML attribute', 'An attribute supplies an element with a named setting such as an identifier, link destination, or input type.', 'Explain why href belongs on an anchor and id identifies one element.', ['web-html--html-element']),
    concept('Element nesting', 'Nesting expresses parent and child structure, subject to the content rules of each element.', 'Explain the parent and children in <ul><li>One</li></ul>.', ['web-html--html-element']),
    concept('Div and span', 'div and span are generic containers without special semantic meaning; their default display behavior differs.', 'Choose a div to group a card and a span to style words inside a sentence.', ['web-html--html-element']),
    concept('Semantic HTML', 'Semantic elements communicate purpose to browsers and assistive tools; appearance alone does not supply that meaning.', 'Choose a button for an action and an anchor for navigation instead of a clickable div.', ['web-html--html-element']),
    concept('Document landmarks', 'Landmarks identify major regions such as navigation and main content; headings describe the content hierarchy.', 'Explain how a page with nav, main, and descriptive headings can be navigated without seeing it.', ['web-html--semantic-html']),
  ]),
  lesson('frontend-web', 'web-dom', 'The DOM and browser rendering', 'Trace markup into a live document tree and distinguish structure, style calculation, layout, and paint.', [
    concept('DOM tree', 'The Document Object Model is the browser object tree representing the current document, which scripts can inspect and change.', 'Explain why inspecting the live DOM can differ from viewing the original HTML.', ['web-html--element-nesting']),
    concept('DOM selection', 'Selectors locate document elements; a selector can match zero, one, or many nodes.', 'Inspect why a selector for #save fails when the rendered button has a different id.', ['web-dom--dom-tree']),
    concept('DOM mutation', 'A DOM mutation changes live document structure, text, or attributes; it does not by itself persist data to a server.', 'Explain why changing textContent disappears on reload.', ['web-dom--dom-tree']),
    concept('Rendering pipeline', 'The browser computes styles, lays out boxes, and paints pixels; different changes invalidate different stages.', 'Distinguish a width change that affects layout from changing visible text color.', ['web-dom--dom-tree']),
  ], ['web-html']),
  lesson('frontend-web', 'web-css-rules', 'CSS rules, cascade, and inheritance', 'Determine which declaration applies to an element and why.', [
    concept('CSS declaration', 'A declaration assigns a value to a CSS property; a rule applies declarations to matching elements.', 'Read color: red and explain which part is the property and which is the value.'),
    concept('CSS selector', 'A CSS selector matches elements using type, class, attributes, relationships, or state.', 'Explain the difference between .card, #card, and .card button.', ['web-html--html-attribute']),
    concept('CSS cascade', 'The cascade chooses between applicable declarations using origin, importance, layers, specificity, and order.', 'Inspect why a later rule does not beat an earlier rule with higher priority.', ['web-css-rules--css-declaration', 'web-css-rules--css-selector']),
    concept('CSS specificity', 'Specificity compares competing selectors within the relevant cascade priority; it is not the entire cascade.', 'Explain why an id selector can beat a class selector without adding !important.', ['web-css-rules--css-selector']),
    concept('CSS inheritance', 'Some properties inherit a computed value from a parent when the child has no overriding value; many box properties do not.', 'Predict why text color reaches a child while its parent margin does not.', ['web-css-rules--css-declaration', 'web-html--element-nesting']),
    concept('Computed style', 'Computed style is the resolved property value after the cascade and value processing, which may differ from authored CSS.', 'Use the inspector to find the winning display rule.', ['web-css-rules--css-cascade']),
  ], ['web-html']),
  lesson('frontend-web', 'web-box-model', 'Boxes, margin, padding, and size', 'Predict the occupied size of an element and distinguish inside spacing from outside spacing.', [
    concept('CSS box model', 'An element box has content, padding, border, and margin regions; these regions participate differently in sizing and layout.', 'Draw the content and surrounding regions of a card.', ['web-css-rules--css-declaration']),
    concept('Padding', 'Padding is space between content and its border and shares the element background.', 'Explain why adding padding moves text inward while increasing the colored region.', ['web-box-model--css-box-model']),
    concept('Margin', 'Margin is space outside the border; adjacent block margins can collapse in normal flow.', 'Explain why adding margin moves neighboring content without expanding the background.', ['web-box-model--css-box-model']),
    concept('Border', 'A border surrounds padding and contributes to the border box size.', 'Account for two 1px borders when predicting total width.', ['web-box-model--css-box-model']),
    concept('Box sizing', 'box-sizing decides whether a declared size measures the content box or the border box.', 'Compare a 200px card with 20px padding under content-box and border-box.', ['web-box-model--padding', 'web-box-model--border']),
    concept('Intrinsic sizing', 'Content has size contributions that constrain how small or large a box can become, even inside a flexible layout.', 'Explain why a long unbroken URL prevents a flex child from shrinking.', ['web-box-model--css-box-model']),
  ], ['web-css-rules']),
  lesson('frontend-web', 'web-layout-flow', 'Display and normal flow', 'Predict where ordinary boxes go before introducing positioning or layout systems.', [
    concept('Normal flow', 'Normal flow lays out block and inline content according to the document structure and available space.', 'Predict where the next paragraph appears when a previous one grows.', ['web-box-model--css-box-model']),
    concept('Block and inline', 'Block and inline display roles determine how a box participates in its parent layout; semantic HTML meaning is separate.', 'Explain why a default div starts a block while a span flows within a line.', ['web-layout-flow--normal-flow', 'web-html--div-and-span']),
    concept('Overflow', 'Overflow occurs when content exceeds a box; visible, hidden, clip, auto, and scroll change how it is displayed or accessed.', 'Diagnose text cut off by a fixed height and overflow: hidden.', ['web-box-model--intrinsic-sizing']),
    concept('Containing block', 'A containing block supplies a coordinate and size reference for properties such as percentages and positioning.', 'Determine which ancestor an absolutely positioned badge uses.', ['web-layout-flow--normal-flow']),
    concept('CSS positioning', 'Positioning modes change offset behavior and whether a box keeps its place in normal flow.', 'Compare relative, absolute, fixed, and sticky for a page header.', ['web-layout-flow--containing-block']),
    concept('Stacking context', 'A stacking context groups painted layers; a child z-index cannot escape the ordering of its ancestor context.', 'Explain why a large z-index still leaves a popup below a neighboring panel.', ['web-dom--rendering-pipeline', 'web-layout-flow--css-positioning']),
  ], ['web-box-model', 'web-dom']),
  lesson('frontend-web', 'web-flexbox', 'One dimensional layout with Flexbox', 'Use a main axis and a cross axis to distribute available space among sibling items.', [
    concept('Flex container', 'display: flex establishes flex layout for direct child items along a chosen main axis.', 'Explain why flex properties on a grandchild do not arrange its grandparent children.', ['web-layout-flow--block-and-inline']),
    concept('Flex axes', 'The main axis follows flex-direction; the cross axis is perpendicular and can change with writing direction.', 'Predict what justify-content centers after switching from row to column.', ['web-flexbox--flex-container']),
    concept('Flex space distribution', 'flex-basis supplies an initial size, while grow and shrink distribute positive or negative free space subject to constraints.', 'Explain why flex: 1 siblings can still overflow because of minimum content sizes.', ['web-flexbox--flex-container', 'web-box-model--intrinsic-sizing']),
    concept('Flex alignment', 'Alignment properties place items or distribute space along the main and cross axes, with different behavior for lines and items.', 'Choose align-items for cross-axis centering and justify-content for the main axis.', ['web-flexbox--flex-axes']),
    concept('Flex wrapping and gap', 'Wrapping creates additional flex lines; gap inserts spacing between items or lines rather than around the container.', 'Build a wrapping toolbar whose outer padding remains separate from its gaps.', ['web-flexbox--flex-container', 'web-box-model--padding']),
  ], ['web-layout-flow']),
  lesson('frontend-web', 'web-grid', 'Two dimensional layout with Grid', 'Describe rows and columns, size their tracks, and place content without positional guessing.', [
    concept('Grid container', 'display: grid creates a layout of row and column tracks for direct child items.', 'Explain when a card matrix benefits from shared columns.', ['web-layout-flow--block-and-inline']),
    concept('Grid tracks', 'Track definitions size grid rows and columns using fixed, flexible, or content-based lengths.', 'Explain how 1fr 2fr divides available space after other constraints.', ['web-grid--grid-container', 'web-box-model--intrinsic-sizing']),
    concept('Grid placement', 'Grid items can be placed by lines, spans, named areas, or automatic placement.', 'Make a page header span both sidebar and content columns.', ['web-grid--grid-tracks']),
    concept('Responsive grid', 'Functions such as minmax and repeat allow track sizes and counts to respond to available space.', 'Explain why repeat(auto-fit, minmax(16rem, 1fr)) wraps cards without a fixed column count.', ['web-grid--grid-tracks']),
  ], ['web-layout-flow']),
  lesson('frontend-web', 'web-responsive', 'Responsive size and visual foundations', 'Explain which dimensions should follow text, parent space, or the viewport and inspect behavior across sizes.', [
    concept('CSS units', 'px, rem, em, percentages, and viewport units use different reference quantities and are not interchangeable.', 'Compare a rem font size with a percentage width.', ['web-css-rules--css-declaration']),
    concept('Media query', 'A media query conditionally applies styles based on environment features such as viewport width or reduced-motion preference.', 'Change a sidebar layout when the viewport can no longer fit both columns.', ['web-css-rules--css-cascade']),
    concept('Container query', 'A container query adapts descendants to an eligible ancestor container rather than the entire viewport.', 'Explain why a card embedded in a narrow sidebar needs its own size condition.', ['web-layout-flow--containing-block']),
    concept('Text layout', 'Font size, line height, measure, wrapping, and whitespace affect readability and the space content occupies.', 'Diagnose a clipped label by checking line-height and whitespace.', ['web-box-model--intrinsic-sizing']),
    concept('Responsive images', 'Image dimensions, aspect ratio, fitting, and source selection control layout stability and delivery cost.', 'Reserve an image aspect ratio so loading it does not move the paragraph below.', ['web-box-model--css-box-model']),
  ], ['web-layout-flow']),
  lesson('frontend-web', 'web-events-forms', 'Events, controls, and forms', 'Trace an interaction to its event, browser default, input value, and validation feedback.', [
    concept('DOM event', 'An event reports an interaction or system occurrence to registered listeners with information about its target.', 'Explain which element receives a click event in a nested button label.', ['web-dom--dom-tree']),
    concept('Event propagation', 'Events can move through capture and bubbling phases; target and currentTarget identify different roles.', 'Explain why clicking a child also triggers a parent listener.', ['web-events-forms--dom-event']),
    concept('Browser default action', 'Some events have default browser behavior; preventDefault cancels a cancelable default and does not stop propagation.', 'Prevent form navigation while preserving deliberate event handling.', ['web-events-forms--dom-event']),
    concept('Form controls', 'Native controls collect values with built-in interaction behavior, names, types, and form submission semantics.', 'Explain why a button inside a form can submit it unless its type is chosen.', ['web-html--semantic-html']),
    concept('Input validation feedback', 'Validation explains invalid input and recovery; client checks improve experience while the server must enforce data rules.', 'Show an error beside an invalid email while rejecting invalid API input independently.', ['web-events-forms--form-controls']),
  ], ['web-dom', 'web-html']),
  lesson('frontend-web', 'web-accessible-interaction', 'Keyboard, focus, and accessible names', 'Prove that an interaction remains understandable and operable without a mouse or visual styling.', [
    concept('Accessible name', 'An accessible name identifies a control to assistive technology; a visible icon alone may supply no useful name.', 'Label an icon-only close button so its purpose can be announced.', ['web-html--semantic-html']),
    concept('Focus management', 'Keyboard focus identifies the active interaction target and must move predictably when content opens, closes, or disappears.', 'Return focus to the triggering button after closing a dialog.', ['web-events-forms--dom-event']),
    concept('Keyboard interaction', 'Controls need appropriate keyboard activation and navigation behavior; adding tabIndex alone does not implement a button.', 'Use Enter and Space to exercise a native action button.', ['web-html--semantic-html']),
    concept('ARIA state and roles', 'ARIA communicates semantics or state when needed, but does not create behavior or replace suitable native controls.', 'Keep aria-expanded synchronized with the actual expanded panel.', ['web-accessible-interaction--accessible-name']),
    concept('Live region', 'A live region can announce an asynchronous status change without moving focus; excessive announcements interfere with use.', 'Announce a save failure while leaving focus in the editor.', ['web-accessible-interaction--aria-state-and-roles']),
  ], ['web-events-forms', 'hci-accessibility'], ['hci-accessibility--color-contrast']),
  lesson('frontend-web', 'react-components', 'React components, JSX, and props', 'Connect a component function and its inputs to the UI tree it describes.', [
    concept('React component', 'A React component describes UI from inputs; React calls it during rendering and manages the resulting tree.', 'Split a reusable card from a page while keeping responsibility clear.', ['programming-functions-interfaces--pure-function', 'web-dom--dom-tree']),
    concept('JSX expression', 'JSX describes UI elements inside JavaScript; braces embed expressions and it is not an HTML string.', 'Explain why {user.name} evaluates a value while quoted text stays literal.', ['practice-js-values--javascript-expression', 'web-html--html-element']),
    concept('Component props', 'Props are inputs supplied by a parent; a child reads them and requests changes through callbacks rather than mutating them.', 'Pass a selected flag and an onSelect callback into a row.', ['react-components--react-component']),
    concept('Conditional rendering', 'Conditional rendering selects which UI subtree is described for the current inputs or state.', 'Render a loading message, error, empty state, or results for the corresponding condition.', ['react-components--jsx-expression']),
    concept('React key', 'A key helps React match sibling elements across renders; stable identity matters when items move or hold state.', 'Explain why using an array index can attach an editor value to the wrong reordered row.', ['react-components--react-component', 'practice-collections--array-operation']),
  ], ['web-dom', 'practice-js-values', 'practice-collections', 'programming-functions-interfaces']),
  lesson('frontend-web', 'react-state', 'React state, events, and data flow', 'Trace a user action through a state update into the next render and choose the owner of shared state.', [
    concept('React state snapshot', 'State belongs to a component instance and each render observes a snapshot; requesting an update schedules a later render.', 'Explain why reading a state variable immediately after setting it still sees that render value.', ['react-components--react-component', 'programming-execution-model--mutable-state']),
    concept('State updater', 'A functional updater derives a next state from the pending previous state and helps compose queued updates.', 'Compare three increment requests using a captured value with three functional updates.', ['react-state--react-state-snapshot']),
    concept('Immutable state update', 'Updating state creates the changed object or array rather than mutating the existing state reference.', 'Replace one item by ID while preserving other list items.', ['react-state--react-state-snapshot', 'practice-collections--object-reference']),
    concept('Lifting state', 'Move shared state to a common owner so coordinated children read one authoritative value.', 'Keep a selected row ID in the parent shared by the list and detail pane.', ['react-components--component-props', 'react-state--react-state-snapshot']),
    concept('Controlled input', 'A controlled input receives its displayed value from state and reports edits through an event handler.', 'Explain why an input with value but no update handler cannot reflect typing.', ['react-state--react-state-snapshot', 'web-events-forms--form-controls']),
    concept('Derived render value', 'A value calculable from current props or state usually can be computed during rendering instead of stored separately.', 'Compute filtered rows from the query and source rows without another synchronization effect.', ['react-state--react-state-snapshot']),
  ], ['react-components', 'web-events-forms'], ['architecture-state--state-ownership']),
  lesson('frontend-web', 'react-effects', 'Effects, lifecycle, and asynchronous UI', 'Synchronize external systems deliberately and prevent old asynchronous work from changing the wrong UI.', [
    concept('React effect', 'An effect synchronizes a committed component with an external system; ordinary derivations and event-specific work often belong elsewhere.', 'Subscribe to a connection in an effect and calculate filtered rows during render.', ['react-state--react-state-snapshot', 'programming-functions-interfaces--side-effect']),
    concept('Effect dependencies', 'Effect dependencies identify reactive values read by the synchronization so it can be updated when those values change.', 'Explain how leaving a selected ID out of dependencies keeps a subscription on an old record.', ['react-effects--react-effect', 'practice-js-functions--closure']),
    concept('Effect cleanup', 'Cleanup releases or invalidates an effect setup before replacement or unmount; setup and cleanup must be safely repeatable.', 'Unsubscribe the exact listener created by an effect.', ['react-effects--react-effect']),
    concept('Stale asynchronous result', 'An earlier request can finish after a later one and incorrectly overwrite current UI unless identity or cancellation guards it.', 'Switch records quickly and reject a response whose record ID is no longer selected.', ['practice-async--promise', 'react-state--lifting-state']),
    concept('UI state machine', 'Explicit states and valid transitions prevent impossible combinations such as saving and successfully saved at once.', 'Describe idle, editing, saving, saved, and failed transitions for a draft.', ['react-state--react-state-snapshot', 'foundations-computation--transition']),
  ], ['react-state', 'practice-async', 'practice-js-functions']),
  lesson('frontend-web', 'web-browser-debugging', 'Debug a rendered page', 'Locate a visual or interaction defect by inspecting actual DOM, styles, events, requests, and state.', [
    concept('Element inspector', 'The element inspector exposes the live DOM and applied styles, letting a hypothesis be checked against rendered structure.', 'Find whether the clipped node or an ancestor owns overflow: hidden.', ['web-dom--dom-tree', 'web-css-rules--computed-style']),
    concept('Layout inspection', 'Layout inspection measures actual box dimensions, flex or grid behavior, containing blocks, and overflow.', 'Measure margin and padding separately before changing a layout rule.', ['web-box-model--css-box-model', 'web-layout-flow--overflow']),
    concept('Network panel', 'The network panel shows actual requests, timing, status, and payloads; visible UI alone does not prove a save request occurred.', 'Inspect the save request, response body, and following reload read.', ['api-http--http-message']),
    concept('Browser console diagnosis', 'Console errors and warnings provide observed symptoms that must be tied to a reproducible interaction and source location.', 'Trace a failed event handler from the console stack to its caller.', ['practice-debugging--stack-trace']),
  ], ['web-dom', 'web-box-model', 'practice-debugging', 'api-http']),

  lesson('developer-practice', 'practice-js-values', 'JavaScript values and expressions', 'Read and predict ordinary JavaScript before relying on framework abstractions.', [
    concept('JavaScript primitive', 'Primitive values include strings, numbers, booleans, null, and undefined; their types affect operations.', 'Explain why a number and its text representation are different inputs.'),
    concept('JavaScript expression', 'An expression evaluates to a value; a statement controls execution or declares something.', 'Explain the value produced by price * quantity.', ['practice-js-values--javascript-primitive']),
    concept('Null and undefined', 'null commonly marks explicit absence while undefined often indicates a missing value; neither should silently become a valid result.', 'Distinguish a missing API field from an intentionally empty selection.', ['practice-js-values--javascript-primitive']),
    concept('Equality and coercion', 'JavaScript comparisons and operators can convert values; strict equality avoids the conversions of loose equality.', 'Explain why a numeric input arriving as text needs intentional parsing.', ['practice-js-values--javascript-primitive']),
    concept('Branch and loop', 'Branches select behavior from conditions and loops repeat behavior until an exit condition is met.', 'Trace a loop across empty, one-item, and many-item arrays.', ['practice-js-values--javascript-expression']),
  ], ['programming-execution-model']),
  lesson('developer-practice', 'practice-js-functions', 'Functions, scope, and modules in practice', 'Trace arguments, return values, captured state, and imports through a small program.', [
    concept('Function call and return', 'Calling a function passes arguments into an invocation and receives its returned value or completion.', 'Explain why forgetting return produces undefined even if a calculation ran.', ['practice-js-values--javascript-expression']),
    concept('Lexical scope', 'Lexical scope determines which binding a name refers to from where code is written.', 'Find whether a handler reads a local variable or an outer binding.', ['programming-execution-model--variable-binding']),
    concept('Closure', 'A closure keeps access to its lexical environment after the surrounding function call completes.', 'Explain which selected ID a saved callback observes.', ['practice-js-functions--lexical-scope']),
    concept('JavaScript module import', 'Imports and exports connect module bindings; module scope and execution affect initialization and sharing.', 'Trace a named import to the module that defines it.', ['practice-js-functions--lexical-scope']),
  ], ['practice-js-values']),
  lesson('developer-practice', 'practice-collections', 'Objects, arrays, and identity', 'Read structured values and transform collections without losing identity or unintended mutation.', [
    concept('Object property', 'Object properties map keys to values; a property can be missing even when the object exists.', 'Inspect whether response.user is missing before reading its name.', ['practice-js-values--null-and-undefined']),
    concept('Object reference', 'Two variables can refer to the same mutable object, so changing it through one name is observable through the other.', 'Explain why copying an outer object does not clone its nested list.', ['practice-collections--object-property']),
    concept('Array operation', 'Arrays are ordered collections; map transforms items, filter selects items, and find selects one matching item.', 'Explain why find can return undefined when a selected ID is absent.', ['practice-js-values--branch-and-loop']),
    concept('Destructuring and spread', 'Destructuring selects fields into bindings; spread copies enumerable entries at one level and does not deep clone nested values.', 'Update a settings field while retaining the other top-level values.', ['practice-collections--object-reference']),
    concept('Collection identity', 'Stable identifiers distinguish records across sorting, updates, persistence, and rendering; position and displayed label are weaker identities.', 'Keep a draft selected by ID after sorting its list.', ['practice-collections--array-operation']),
  ], ['practice-js-values']),
  lesson('developer-practice', 'practice-async', 'Promises, async work, and errors', 'Predict what runs now, what resumes later, and where a failure is observed.', [
    concept('Promise', 'A promise represents an eventual fulfilled value or rejection; creating or receiving it is not the same as waiting for it.', 'Explain why logging fetch output immediately shows a promise.', ['practice-js-functions--function-call-and-return']),
    concept('Async and await', 'An async function returns a promise, and await suspends that function until the awaited operation settles.', 'Trace the order of logs around an awaited request without assuming the whole process blocks.', ['practice-async--promise']),
    concept('Event loop and microtasks', 'The runtime schedules queued callbacks and promise continuations around synchronous execution; CPU-bound code still delays them.', 'Explain why a long synchronous loop delays a timer.', ['practice-async--promise', 'programming-execution-model--call-stack']),
    concept('Async error handling', 'A rejected promise must reach an awaited or explicitly handled boundary; a detached promise can fail outside a surrounding synchronous catch.', 'Catch a failed awaited request and preserve the cause for diagnosis.', ['practice-async--async-and-await', 'programming-errors-tests--exception']),
    concept('Cancellation signal', 'Cancellation communicates that work is no longer wanted; each participating operation must honor it, and remote effects may already have happened.', 'Abort an obsolete search request without claiming that a completed server write was undone.', ['practice-async--promise']),
  ], ['practice-js-functions', 'programming-errors-tests']),
  lesson('developer-practice', 'practice-typescript', 'TypeScript boundaries and narrowing', 'Use static types to explain possible values while validating unknown runtime input.', [
    concept('Type annotation', 'A type annotation states the static contract checked by TypeScript; it does not convert or validate a runtime value.', 'Explain why labeling a JSON response as User does not verify its fields.', ['programming-data-abstractions--data-type']),
    concept('Union and narrowing', 'A union permits several alternatives; control-flow checks narrow which alternatives are possible at a point in the program.', 'Check for null before accessing a selected record.', ['practice-typescript--type-annotation', 'practice-js-values--null-and-undefined']),
    concept('Discriminated union', 'A shared literal discriminator connects each state to its valid fields, making invalid combinations easier to reject statically.', 'Model success with data and failure with an error instead of optional fields everywhere.', ['practice-typescript--union-and-narrowing']),
    concept('Generic type parameter', 'A generic parameter expresses a relationship between types across inputs and outputs rather than discarding their distinctions.', 'Explain how a list helper preserves the type of each item.', ['practice-typescript--type-annotation']),
    concept('Runtime schema validation', 'A runtime schema checks actual external values and reports invalid input; it complements static checking.', 'Reject an API payload whose quantity is text when the boundary requires a number.', ['practice-typescript--type-annotation']),
  ], ['practice-js-values', 'programming-data-abstractions']),
  lesson('developer-practice', 'practice-terminal', 'Files, processes, and the terminal', 'Explain where commands run, which inputs they read, and how their results are observed.', [
    concept('Working directory and path', 'Relative paths resolve from a working directory; absolute paths identify a location independently of it.', 'Explain why the same command finds a file in one directory but not another.'),
    concept('Command arguments', 'A shell parses command text into arguments and performs expansions; quoting controls whether text is interpreted or passed literally.', 'Pass a filename containing spaces as one argument.'),
    concept('Standard streams', 'A process reads stdin and writes stdout and stderr; redirection changes where those streams go.', 'Preserve a JSON response on stdout while diagnosing logs on stderr.'),
    concept('Exit status', 'A process exit status reports its own success convention; it does not by itself prove the desired external behavior.', 'Inspect an assertion report even when a wrapper command exits zero.'),
    concept('Environment variable', 'An environment variable supplies process configuration inherited at launch; changing a file does not update a running process automatically.', 'Explain why a restarted process sees a changed API origin.', ['programming-runtimes-concurrency--process']),
  ]),
  lesson('developer-practice', 'practice-debugging', 'Reproduce, inspect, and localize a bug', 'Turn a surprising behavior into a falsifiable hypothesis about the smallest failing boundary.', [
    concept('Minimal reproduction', 'A minimal reproduction preserves the failure while removing irrelevant inputs and steps.', 'Reduce a failing save to one record and the exact interaction that loses its body.'),
    concept('Expected versus actual', 'A bug report separates the intended observable result from the result actually witnessed.', 'State that the editor is empty after reload despite a stored draft body.'),
    concept('Stack trace', 'A stack trace identifies a chain of calls associated with an error, not necessarily its root cause.', 'Follow a parse error back to the response that supplied invalid data.', ['programming-execution-model--call-stack']),
    concept('Breakpoint and watch', 'A debugger can pause execution and inspect live values at a chosen boundary.', 'Inspect the selected record ID immediately before rendering its editor.', ['programming-execution-model--variable-binding']),
    concept('Hypothesis and experiment', 'A debugging hypothesis predicts an observation; a controlled check should distinguish it from competing explanations.', 'Compare stored body, returned body, and rendered body to find the first mismatch.', ['practice-debugging--expected-versus-actual']),
    concept('Causal boundary trace', 'Trace one identity and value across boundaries to locate where correct state first becomes incorrect.', 'Follow a save through event handler, RPC input, database row, reload response, and selected editor.', ['practice-debugging--hypothesis-and-experiment']),
  ], ['programming-execution-model'], ['programming-errors-tests--debugging-hypothesis']),
  lesson('developer-practice', 'practice-testing', 'Assertions that prove behavior', 'Choose inputs and observations that would catch the reported defect and preserve the relevant contract.', [
    concept('Behavioral assertion', 'A behavioral assertion checks a meaningful externally observed property rather than repeating implementation logic.', 'Assert the selected draft body after reload, not only that a save helper was called.', ['programming-errors-tests--test-oracle']),
    concept('Regression test', 'A regression test exercises the triggering case and rejects the old incorrect result.', 'Keep a test for changing selected rows while their asynchronous responses arrive out of order.', ['practice-testing--behavioral-assertion']),
    concept('Boundary and negative case', 'Boundary and invalid inputs reveal behavior that a representative success case can miss.', 'Exercise empty data, missing IDs, failed requests, and duplicate submissions.', ['practice-testing--behavioral-assertion']),
    concept('Fixture isolation', 'A fixture owns unique test data and cleanup so concurrent or repeated tests do not corrupt each other.', 'Give two browser tests separate draft IDs and verify each deletes only its own records.', ['delivery-testing--integration-test']),
    concept('Mock boundary', 'A mock replaces an interaction and limits what a test can prove; mocked transport cannot certify real authentication or persistence.', 'Use a pure policy test and a separate authenticated save-and-reload check.', ['programming-errors-tests--test-double']),
  ], ['practice-debugging', 'programming-errors-tests'], ['delivery-testing--unit-test', 'delivery-testing--integration-test', 'delivery-testing--end-to-end-test']),
  lesson('developer-practice', 'practice-git', 'Inspect and change a shared repository', 'Separate working edits, staged changes, history, and conflicts before modifying shared work.', [
    concept('Working tree and index', 'The working tree contains current files and the index selects the next commit content; they can differ.', 'Explain why a staged file can also have unstaged edits.', ['delivery-version-control--repository']),
    concept('Diff and hunk', 'A diff describes changes between states, and a hunk groups nearby changed lines rather than proving semantic correctness.', 'Review the exact changed function without reverting a neighboring agent edit.', ['practice-git--working-tree-and-index']),
    concept('Conflict resolution', 'Resolving a conflict requires preserving the intended behavior of competing changes, not merely removing conflict markers.', 'Combine a renamed parameter with a new validation rule and inspect both callers.', ['delivery-version-control--merge-conflict']),
    concept('Reversible change', 'A reversible change has a known bounded way to undo its effect and preserves the data needed for recovery.', 'Use a small scoped patch and retain previous evidence before changing a shared service.', ['practice-git--diff-and-hunk']),
  ], ['delivery-version-control']),
  lesson('developer-practice', 'practice-runtime', 'Build, load, and verify the running revision', 'Distinguish source edits, generated contracts, loaded code, and the process serving a request.', [
    concept('Source versus runtime', 'A correct source file does not prove a running process has loaded it; build output and process lifetime determine active behavior.', 'Compare an API revision endpoint with the source revision being tested.', ['practice-terminal--environment-variable']),
    concept('Hot module reload', 'Hot reload replaces supported modules in an active runtime, but retained service instances or generated metadata can remain stale.', 'Explain why editing a seed does not rerun initialization on an existing service.', ['practice-runtime--source-versus-runtime']),
    concept('Generated contract', 'Generated schemas and wiring are derived artifacts consumed by tools or runtimes; source and generated versions must agree.', 'Verify a newly used RPC exists in generated workflow metadata before executing it.', ['architecture-contracts--interface-contract']),
    concept('Dependency resolution', 'A runtime or build tool resolves an import to a concrete dependency version and location; lockfiles constrain reproducibility.', 'Explain why installing a package and restarting a process can load a different implementation.', ['delivery-build-release--dependency-lockfile']),
    concept('Runtime health check', 'A useful health check proves a required behavior or dependency in the serving process; a listening socket proves less.', 'Read real curriculum metadata through the authenticated public dev route after a load.', ['practice-runtime--source-versus-runtime']),
  ], ['practice-terminal', 'delivery-build-release']),

  lesson('web-apis', 'api-url', 'URLs, origins, and browser navigation', 'Identify the resource and authority in a URL and trace where a browser sends a request.', [
    concept('URL components', 'A URL separates scheme, host, optional port, path, query, and fragment; these parts have different routing and client roles.', 'Explain why a fragment changes browser navigation but is not sent as the HTTP request target.'),
    concept('Origin', 'A web origin combines scheme, host, and port and defines many browser security boundaries.', 'Explain why two localhost ports are different origins.', ['api-url--url-components']),
    concept('Relative URL resolution', 'A relative URL resolves against a base URL, so a leading slash and a path-relative reference can target different routes.', 'Compare fetch("api/save") and fetch("/api/save") from a nested page.', ['api-url--url-components']),
    concept('Navigation versus data request', 'Navigation asks the browser to load a document; a script request retrieves data without itself replacing the page.', 'Explain why returning JSON from an API route differs from loading an application page.', ['api-url--url-components']),
  ]),
  lesson('web-apis', 'api-http', 'Read a real HTTP exchange', 'Explain the method, target, headers, status, and body of an actual application request.', [
    concept('HTTP message', 'An HTTP interaction carries a request and response with control information, headers, and optional content.', 'Read a draft-save request and explain where its JSON body is carried.', ['api-url--url-components']),
    concept('HTTP method', 'A method expresses request semantics; safe and idempotent have specific meanings and do not merely mean that a request succeeded.', 'Explain why a read endpoint should not send an email.', ['api-http--http-message']),
    concept('HTTP status family', 'Status codes communicate response outcomes; a successful transport status still requires checking the promised response content.', 'Distinguish unauthenticated, forbidden, missing resource, and server failure responses.', ['api-http--http-message']),
    concept('Headers and content type', 'Headers carry message metadata; content type identifies the representation so the body can be interpreted correctly.', 'Diagnose JSON parsing that received an HTML sign-in page.', ['api-http--http-message']),
    concept('JSON serialization', 'JSON encodes supported structured values as text; parsing reconstructs values but does not validate the application schema.', 'Explain why a timestamp arrives as text and must be interpreted deliberately.', ['practice-collections--object-property']),
    concept('Fetch response handling', 'fetch resolves to a response for HTTP error statuses as well as success, so callers must inspect status and parse the intended body.', 'Handle a 500 response separately from a network rejection.', ['practice-async--promise', 'api-http--http-status-family']),
  ], ['api-url', 'practice-collections', 'practice-async'], ['networks-application--http-semantics']),
  lesson('web-apis', 'api-browser-security', 'Cookies, CORS, and request authority', 'Separate session continuity, browser read policy, and server authorization.', [
    concept('HTTP cookie', 'A cookie stores scoped browser state sent according to domain, path, security, and same-site rules.', 'Explain why a session cookie is absent from a cross-origin request.', ['api-url--origin', 'api-http--http-message']),
    concept('Same origin policy', 'The same-origin policy restricts how scripts can read or interact with resources across origins; it does not forbid every cross-origin request.', 'Explain why an image can load while reading another origin API response is blocked.', ['api-url--origin']),
    concept('CORS', 'CORS is a server opt-in protocol for browser cross-origin response access; it is not user authentication or authorization.', 'Diagnose a preflight failure without disabling server authorization.', ['api-browser-security--same-origin-policy', 'api-http--headers-and-content-type']),
    concept('Credential handling', 'Credentials prove or carry authority and need deliberate storage and transport boundaries; they should not enter logs or client bundles.', 'Keep a server API secret out of a frontend environment variable.', ['security-identity-access--authentication', 'security-identity-access--authorization']),
    concept('Server authorization check', 'The server checks the actor action and target resource on each protected operation; hiding a button is not enforcement.', 'Reject saving another user draft even when the request is crafted directly.', ['security-identity-access--authorization']),
  ], ['api-http', 'security-identity-access']),
  lesson('web-apis', 'api-contracts', 'Endpoint contracts and reliable reads', 'Make API input, output, errors, paging, and retry behavior explicit to callers.', [
    concept('Request boundary validation', 'Validate input at the trusted server boundary before using it, with errors the caller can interpret.', 'Reject an invalid draft ID before issuing a database update.', ['practice-typescript--runtime-schema-validation']),
    concept('Cursor pagination', 'Cursor pagination returns a continuation token for following pages; one successful page is not a complete collection.', 'Follow nextCursor until absent while avoiding duplicate records.', ['api-http--http-message']),
    concept('Timeout versus cancellation', 'A timeout bounds how long a caller waits; it does not prove remote work stopped or that a write failed.', 'After a save timeout, check operation identity before retrying the write.', ['practice-async--cancellation-signal']),
    concept('Retry backoff', 'A retry policy bounds attempts and delays them, often with jitter, while distinguishing transient errors from permanent invalid input.', 'Retry a temporary upstream failure but do not retry a validation error.', ['api-http--http-status-family']),
    concept('HTTP cache validation', 'Validators let a client check whether a stored representation remains current without always downloading its full body.', 'Explain how an ETag and conditional request can produce a not-modified response.', ['api-http--http-message']),
  ], ['api-http', 'practice-typescript']),
  lesson('web-apis', 'api-request-path', 'Trace a request through deployed services', 'Locate failure across name resolution, connection, proxy routing, handler logic, and database state.', [
    concept('Request routing', 'A router or proxy selects a handler or upstream from the request path and other routing rules.', 'Explain how a broad static-file rule can intercept an intended API request.', ['api-url--url-components']),
    concept('Reverse proxy', 'A reverse proxy receives client requests and forwards them to selected application services, potentially applying auth, caching, or limits.', 'Compare a working direct backend call with the same request through the public dev origin.', ['api-request-path--request-routing']),
    concept('Transport versus application failure', 'Name lookup, connection, TLS, HTTP status, and application data errors occur at different boundaries and require different evidence.', 'Distinguish connection refused from an HTTP 403 and from a valid response containing the wrong record.', ['api-http--http-status-family']),
    concept('Request correlation', 'A correlation identifier connects observations for the same request or operation across services without exposing private payloads.', 'Find the handler log and save transaction belonging to one browser request.', ['delivery-observability--log-event']),
  ], ['api-http'], ['networks-addressing-routing--domain-name-system', 'networks-transport--port']),

  lesson('data-databases', 'data-sql-practice', 'Read and change relational data safely', 'Predict which rows a query selects or changes and verify the intended relation and identity.', [
    concept('SQL filtering and projection', 'SELECT chooses output columns and WHERE constrains qualifying rows; an omitted filter can change the scope of a query.', 'Read the exact selected draft by primary key before changing it.', ['data-relational--primary-key']),
    concept('SQL join cardinality', 'A join combines matching rows and can multiply results when either side has multiple matches.', 'Explain why joining lessons to shared concepts can double-count assessments.', ['data-relational--foreign-key']),
    concept('SQL grouping and aggregation', 'Grouping defines the grain of aggregate results; filtering before or after aggregation answers different questions.', 'Compute one count per lesson without treating duplicated join rows as unique concepts.', ['data-sql-practice--sql-join-cardinality']),
    concept('Parameterized query', 'Query parameters carry values separately from SQL syntax, preventing those values from becoming SQL instructions.', 'Bind a user-supplied draft ID instead of concatenating it into a query.', ['data-sql-practice--sql-filtering-and-projection']),
    concept('Scoped data mutation', 'A write targets explicitly identified rows and checks affected records; a successful statement can still have an incorrect scope.', 'Require the expected draft ID and owner before updating its body.', ['data-sql-practice--sql-filtering-and-projection']),
  ], ['data-relational']),
  lesson('data-databases', 'data-persistence-proof', 'Persistence, migrations, and read-back', 'Separate memory, stored truth, derived projections, and historical versions when changing data.', [
    concept('Write and read-back', 'Persistence is demonstrated by reading the intended stored value after the write, including after a fresh load.', 'Verify saved body, record identity, reload response, and rendered editor all agree.', ['data-transactions--durability']),
    concept('Schema migration', 'A schema migration changes database structure with explicit ordering and compatibility assumptions for existing data and code.', 'Add a nullable field before requiring every older row to populate it.', ['data-data-models--schema']),
    concept('Seed ownership', 'A seed updater needs an explicit ownership boundary so replacing generated content does not overwrite user-authored or unrelated data.', 'Sync one curriculum without retiring every other seed curriculum.', ['data-sql-practice--scoped-data-mutation']),
    concept('Immutable snapshot', 'An immutable snapshot preserves the exact input version behind a result; later edits create new versions rather than rewriting that evidence.', 'Keep a classifier catalog and its order frozen when the live curriculum expands.', ['data-data-models--schema']),
    concept('Derived projection rebuild', 'A derived projection can be rebuilt from retained source records, but rebuilding it is not permission to delete or reinterpret those sources.', 'Rebuild lesson memberships while preserving archived conversations and assessment receipts.', ['architecture-state--source-of-truth']),
  ], ['data-sql-practice', 'data-transactions'], ['architecture-state--source-of-truth']),

  lesson('durable-workflows', 'workflow-durable-steps', 'Durable steps and checkpoints', 'Explain what survives a crash and what state a resumed operation uses.', [
    concept('Durable workflow step', 'A durable step records its identity and outcome so recovery can reuse completed work and continue unfinished phases.', 'Resume an import after parsing without paying to parse the same completed input again.', ['architecture-event-systems--workflow-orchestration']),
    concept('Checkpoint', 'A checkpoint durably records progress at a defined boundary; in-memory progress disappears when its process stops.', 'Persist the last projected source version after a successful batch.', ['data-transactions--durability']),
    concept('Replay semantics', 'Replay defines which completed results are reused and which effects may run again; a resumed function is not automatically safe.', 'Distinguish resuming a paid-call receipt from repeating the paid call.', ['workflow-durable-steps--durable-workflow-step']),
    concept('Terminal workflow state', 'Completed, failed, cancelled, and uncertain states need explicit meanings and evidence so a stuck operation cannot masquerade as success.', 'Report a missing paid-call receipt as uncertain rather than completed.', ['workflow-durable-steps--checkpoint']),
  ], ['architecture-event-systems', 'data-transactions']),
  lesson('durable-workflows', 'workflow-idempotency', 'Operation identity and duplicate effects', 'Separate logical work identity, delivery attempts, completed effects, and retries.', [
    concept('Idempotency key', 'An idempotency key identifies one logical operation so repeated delivery can adopt an existing result instead of duplicating effects.', 'Reuse the same operation key when retrying a draft creation after an ambiguous timeout.', ['architecture-event-systems--idempotency']),
    concept('Delivery versus effect', 'A message delivery and its external effect are different events; at-least-once delivery can cause repeated effects without deduplication.', 'Explain why receiving a job twice must not send two emails.', ['architecture-event-systems--delivery-guarantee']),
    concept('Atomic claim', 'An atomic claim coordinates which worker owns one operation using a transactional or uniqueness boundary.', 'Have competing workers adopt one durable child workflow under a lock.', ['data-transactions--atomic-transaction']),
    concept('Uncertain external outcome', 'When an external call may have succeeded but its result was not recorded, failure cannot safely be inferred from missing local acknowledgment.', 'Reconcile a provider request ID before repeating a potentially charged call.', ['api-contracts--timeout-versus-cancellation']),
    concept('Transactional outbox', 'An outbox stores a business change and a pending message in the same database transaction, then delivers the message with replay handling.', 'Commit a draft transition and its notification event together, then deduplicate delivery.', ['data-transactions--atomic-transaction', 'workflow-idempotency--delivery-versus-effect']),
  ], ['workflow-durable-steps', 'api-contracts']),
  lesson('durable-workflows', 'workflow-queue-capacity', 'Queues, concurrency, and backpressure', 'Distinguish available worker slots from batches, rate limits, and producer pressure.', [
    concept('Worker concurrency', 'Concurrency bounds simultaneously active jobs; it does not directly bound requests per second or total work.', 'Explain why nine worker slots can process a hundred queued jobs over time.', ['architecture-event-systems--message-queue']),
    concept('Rolling scheduling', 'Rolling scheduling starts the next independent job when a slot becomes free rather than waiting for an entire wave to finish.', 'Start job ten while six of the first nine jobs are still running.', ['workflow-queue-capacity--worker-concurrency']),
    concept('Backpressure', 'Backpressure slows or bounds producers when downstream capacity is insufficient so queues and resource use do not grow without control.', 'Pause new acquisition when pending parse work exceeds the configured capacity.', ['workflow-queue-capacity--worker-concurrency']),
    concept('Rate limit', 'A rate limit bounds activity in a time interval or quota window, which is different from limiting simultaneous requests.', 'Keep concurrent workers within a provider request-per-minute allowance.', ['workflow-queue-capacity--worker-concurrency']),
    concept('Queue acknowledgment', 'An acknowledgment records delivery progress according to queue semantics; acknowledging before a durable result can lose work.', 'Acknowledge a job after its result is durable, while making redelivery safe.', ['workflow-idempotency--delivery-versus-effect']),
  ], ['workflow-idempotency']),
  lesson('durable-workflows', 'workflow-recovery', 'Leases, reconciliation, and recovery proof', 'Make abandoned or ambiguous work detectable and define a bounded path back to progress.', [
    concept('Worker lease', 'A lease grants temporary ownership that can expire; duration, renewal, and reclaim behavior affect crash recovery.', 'Explain why a crashed queue worker can delay adoption until its lease expires.', ['workflow-idempotency--atomic-claim']),
    concept('Heartbeat', 'A heartbeat reports recent liveness but does not by itself prove useful progress or a completed durable effect.', 'Compare a live process heartbeat with a stuck source watermark.', ['workflow-recovery--worker-lease']),
    concept('Reconciliation', 'Reconciliation compares intended state with durable observations and repairs only discrepancies supported by operation identity.', 'Adopt an already-created native job instead of enqueueing a duplicate.', ['workflow-idempotency--idempotency-key']),
    concept('Watermark', 'A watermark identifies processed source progress; its semantics must account for updates, ordering, and partial batches.', 'Advance a cursor only past inputs whose projection has committed.', ['workflow-durable-steps--checkpoint']),
    concept('Crash recovery test', 'A recovery test interrupts work at a meaningful failure boundary and verifies resumed results, duplicate effects, and unresolved uncertainty.', 'Kill a worker after an external result but before receipt persistence and inspect reconciliation behavior.', ['workflow-idempotency--uncertain-external-outcome', 'workflow-recovery--reconciliation']),
  ], ['workflow-queue-capacity']),

  lesson('llm-collaboration', 'llm-task-specification', 'Specify intent and acceptance', 'Turn a request into a bounded goal with the evidence needed to decide whether it is complete.', [
    concept('Task scope', 'Task scope identifies the systems, files, actions, and outcome authorized by a request.', 'Specify a dev curriculum update without authorizing production deployment.', ['professional-problem-framing--constraint']),
    concept('Acceptance evidence', 'Acceptance evidence states which observable results must hold, including important preserved behavior.', 'Require a real save, reload, exact selected row, and visible editor body.', ['professional-problem-framing--success-criterion']),
    concept('Context selection', 'Useful context supplies the relevant source facts, constraints, and current state without treating every available document as necessary.', 'Provide the failing request and its handler rather than the entire repository.'),
    concept('Constraint persistence', 'Earlier accepted constraints continue to apply across follow-ups unless the user changes them.', 'Keep the no-production boundary while responding to a later request for speed.', ['llm-task-specification--task-scope']),
    concept('Clarification threshold', 'Clarify missing choices when they materially change the outcome or authority; routine reversible implementation choices can follow available context.', 'Ask which customer account is intended when two targets match, while continuing read-only inspection.', ['llm-task-specification--task-scope']),
  ], ['professional-problem-framing']),
  lesson('llm-collaboration', 'llm-evidence-judgment', 'Judge model claims and evidence', 'Distinguish plausible generated output, verified observations, and unresolved uncertainty.', [
    concept('Claim verification', 'A model assertion needs supporting observations appropriate to its consequence; confident prose is not evidence.', 'Check the actual response body and persisted row behind a claimed successful fix.'),
    concept('Source-grounded quotation', 'A quotation must match its identified source and speaker; surrounding context determines what it supports.', 'Reject an assistant explanation misattributed as a human demonstration.'),
    concept('Unknown versus incorrect', 'Missing evidence does not establish inability or error; unknown state should remain distinct from observed failure.', 'Leave a concept unassessed when the human only asks for a code change.'),
    concept('Provisional assessment', 'A provisional assessment is a revisable inference from limited evidence, not a measured probability or certification of mastery.', 'Record partial demonstrated understanding and the remaining gap without claiming durable mastery.', ['llm-evidence-judgment--unknown-versus-incorrect']),
    concept('Independent verification', 'Independent verification checks the underlying behavior or evidence without relying solely on the implementer conclusions.', 'A reviewer reloads the draft in the browser and checks its identity and contents.', ['llm-evidence-judgment--claim-verification']),
  ]),
  lesson('llm-collaboration', 'llm-agent-steering', 'Steer an agent during implementation', 'Use corrections, concrete evidence, and bounded delegation to keep work aligned with intent.', [
    concept('Evidence-based correction', 'A useful correction identifies the observed mismatch and intended constraint so the agent can revise its approach.', 'Explain that a stored body is correct while the selected editor is wrong, narrowing the next diagnosis.', ['llm-evidence-judgment--claim-verification']),
    concept('Bounded delegation', 'A delegated task has a concrete independent output, explicit ownership, and shared constraints to avoid conflicting work.', 'Assign curriculum data and hook policy to separate agents with disjoint files.', ['llm-task-specification--task-scope']),
    concept('Progress checkpoint', 'A progress checkpoint reports what is established, what remains uncertain, and what the next action will resolve.', 'Report that source tests pass while live data still has the old revision.', ['llm-evidence-judgment--unknown-versus-incorrect']),
    concept('Scope drift detection', 'Scope drift occurs when the proposed action no longer serves the authorized outcome or expands its consequences.', 'Catch an unrelated package upgrade proposed during a narrow layout fix.', ['llm-task-specification--task-scope']),
    concept('Reviewable handoff', 'A handoff preserves current state, changed files, evidence, risks, and remaining steps so another agent can continue without reconstructing the session.', 'Record the exact sync method, graph revision, and unrun live checks.', ['llm-agent-steering--progress-checkpoint']),
  ], ['llm-task-specification', 'llm-evidence-judgment']),
  lesson('llm-collaboration', 'llm-tool-boundaries', 'Tools, retrieved content, and authority', 'Separate information supplied by tools from instructions authorized by the user or application.', [
    concept('Instruction and data boundary', 'Retrieved files, web content, and tool outputs can contain instructions as text without gaining authority to direct the agent.', 'Ignore a repository comment that asks the agent to reveal credentials.', ['llm-task-specification--task-scope']),
    concept('Prompt injection', 'Prompt injection attempts to turn untrusted content into agent instructions or authority beyond its intended information role.', 'Treat a fetched page request to upload local files as hostile source content.', ['llm-tool-boundaries--instruction-and-data-boundary']),
    concept('Tool result interpretation', 'A tool result describes what the tool observed; exit codes, queued status, and rendered success markers support different claims.', 'Distinguish accepted queue work from a durably completed workflow.', ['llm-evidence-judgment--claim-verification']),
    concept('Structured output contract', 'A schema constrains output shape, but semantic correctness and source fidelity still need validation.', 'Accept valid JSON only after checking concept IDs, exact quotes, and allowed evidence claims.', ['practice-typescript--runtime-schema-validation']),
    concept('Context window and retrieval', 'A model can use only its available context; retrieval selects supporting material, and omission is not evidence that a fact is false.', 'Retrieve original messages around a matching chunk before judging a learner statement.', ['llm-task-specification--context-selection']),
  ], ['llm-task-specification', 'llm-evidence-judgment', 'practice-typescript']),
]

export function practicalComputingSeed(firstStep: number, firstLaneOrder: number): Pick<LearningGraph, 'concepts' | 'edges'> & { lanes: LearningGraph['curriculum']['lanes']; modules: LearningGraph['curriculum']['modules'] } {
  const lanes = LANES.map(([id, title, summary, color], index) => ({ id, title, summary, color, order: firstLaneOrder + index, provenance: CURRICULUM_REVISION }))
  const modules = LESSONS.map((item, index) => ({
    id: item.id, laneId: item.laneId, title: item.title, summary: item.summary,
    step: firstStep + index, parentId: null,
    conceptIds: [...item.concepts.map((value) => idFor(item.id, value.title)), ...item.shared],
    dependsOnModuleIds: [...item.dependsOn],
    masteryGoals: [`Explain and predict the mechanism: ${item.summary}`, `Diagnose a concrete failure in ${item.title.toLowerCase()} and predict which observation would confirm the cause.`],
    provenance: CURRICULUM_REVISION,
  }))
  const concepts = LESSONS.flatMap((item, lessonIndex) => item.concepts.map((value, index) => ({
    id: idFor(item.id, value.title), title: value.title, summary: value.summary,
    explanation: `${value.summary} ${item.summary}`, example: value.example,
    domain: item.laneId, capability: 'explain-predict-diagnose', provenance: CURRICULUM_REVISION,
    x: 120 + ((14 + Math.max(0, lanes.findIndex((lane) => lane.id === item.laneId))) * 170) + ((index % 2) * 70),
    y: 90 + (lessonIndex * 145) + (index * 18),
  })))
  const edges: LearningGraph['edges'] = LESSONS.flatMap((item) => item.concepts.flatMap((value) => value.requires.map((from) => ({
    from, to: idFor(item.id, value.title), kind: 'hard-prerequisite' as const, confidence: 0.9, provenance: CURRICULUM_REVISION,
  }))))
  return { lanes, modules, concepts, edges }
}
