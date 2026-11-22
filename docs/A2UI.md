# A2UI widgets in Relay

An `a2ui` block puts a small live widget on a board: a status list, a few numbers, a progress bar, or a short form with buttons. Write it in A2UI Express. Relay compiles the text with the official A2UI agent SDK against Relay's own catalog and draws it with its own renderer.

Use a widget for state and quick actions. Use the board's question blocks (`single`, `multi`, `text`) for any answer you depend on, because those come back in `result.answers` with notes and comments. A widget never replaces a question you must have answered.

## Add one to a board

```json
{
  "title": "Release checks",
  "blocks": [
    {
      "id": "checks",
      "type": "a2ui",
      "title": "Release checks",
      "express": "$/runs = [{title: \"Build\", trailing: \"2m\", tone: \"ok\"}, {title: \"E2E\", trailing: \"failed\", tone: \"error\"}]\nroot = Card(\"Release checks\", [List($/runs), Button(\"Retry E2E\", action=Event(\"retry\", {job: \"e2e\"}))])"
    }
  ],
  "questions": [
    { "id": "go", "type": "yesno", "label": "Ship after the retry?" }
  ]
}
```

Send `components` (a flat A2UI v1.0 component list with a `dataModel`) instead of `express` when you already hold JSON. Give exactly one of the two. `height` (pixels) limits the block's height.

## What comes back

The person's clicks and input values are part of the board result, under `result.blockEdits[blockId]`:

```json
{ "type": "a2ui", "data": { "note": "via phone" }, "events": [{ "name": "retry", "context": { "job": "e2e" }, "at": "2026-11-22T10:15:00.000Z" }] }
```

- `data` is the widget's data model with the current value of every input.
- `events` lists each button press in order. Name an event for what the person decided (`approve`, `retry`), and put the values you need into its context.
- Clicks are recorded in the draft and sent with the board when the person submits. A button does not submit the board.

## Rules for good widgets

- One widget, one purpose. At most 60 components, 64 KB of data, 12 levels deep. Put the state first.
- The root is a `Card`. State is a tone: `ok`, `info`, `warn`, `error` or `needs` (the person has to act). Never name a colour.
- Text is drawn as text. Markup, HTML and script in a string are shown as written, never run. Links open only when they are https URLs.
- Bind with `$/path`. Paths with `__proto__`, `constructor` or `prototype` segments are refused at compile time.
- The grammar below says to wrap Express in `<a2ui>` tags. In a Relay spec, leave the tags out: the `express` field holds the Express text alone.
- Run `rly ask --file spec.json --detach` as usual: a spec with an invalid widget fails before the board opens, with the compiler's message.


The rest of this page comes from the A2UI agent SDK, generated from Relay's catalog (`src/a2ui/catalog.json`) and examples (`src/a2ui/examples.json`).

# A2UI Express DSL Output Contract

You must output the user interface using A2UI Express.

IMPORTANT: You MUST always surround the entire A2UI Express block with the literal sentinel tags `<a2ui>` and `</a2ui>` (always include both the opening and closing tags; do NOT wrap the tags in backticks or replace the opening tag with a markdown code fence such as ```a2ui).

The host compiler will compile your A2UI Express output into the correct JSON envelopes automatically.

## Grammar Rules

1. Component constructors can be assigned to variables or nested inline inside parent component arguments:
   header = ComponentA(prop1="val1")
   root = ComponentB([header, ComponentC("Click", action=Event("submit"))])

   Keyword arguments (`param=value`) and positional arguments with `_` placeholders are supported.

   Variable names MUST start with a letter or underscore, and only contain letters, digits, and underscores.

2. The interface tree must have a single entry point assigned to the reserved variable 'root'.

3. Primitives:
   - Strings: Quoted with `"` or `"""`. Support for `\n`, `\t`, `\\`, and `\"` escapes.
     Raw Strings: Prefaced by `r` (e.g., `r"..."` or `r"""..."""`), with no escape processing.
   - Numbers: write as integers or decimals, e.g., 42
   - Booleans: write true or false
   - Null values: write null
   - Dates & Times: Values for date-time inputs (e.g. in DateTimeInput) must strictly use RFC 3339 format with a timezone offset (e.g. "2026-03-14T00:00:00Z").

4. Lists: represent as arrays, e.g., [child1, child2].

5. Maps: represent as key-value blocks, e.g., {title: "Overview", child: contentCol}. Map keys are always literal strings (dynamic variable resolution is not supported for keys).

6. Data bindings: prefix absolute paths in the data model with '$', e.g., $/user/firstName.
   Prefix relative list scopes with '$', e.g., $firstName.
   A lone '$' represents an empty relative path which resolves to the root of the current context (e.g. inside a template, representing the entire item itself).

7. Logic and validation: prefix client check rules with '?', e.g., ?required or ?regex("^[0-9]{5}$"). To specify a custom error message for validation failures, append it as an extra string argument, e.g. ?regex("^[0-9]{5}$", "Postal code must be 5 digits").

8. Action events: represent server-side actions using the Event helper:
   Event("save_deal", {rep: $/form/rep})

9. Nested functions: call client functions directly using catalog signatures, for example myFunction("value").

10. Data model population: Assign a value directly to an absolute data path (e.g. $/path/to/key = "value") to populate or initialize values inside the shared dataModel. The value can be a primitive, array, or map.

11. Dynamic list templates: If a component expects a template child list, represent it using the _template helper:
    _template($/path/to/list, itemTemplate)
    And define the template component variable on another line, utilizing relative path references prefixed with $:
    itemTemplate = Image($url)

12. To delete a user interface surface, output the standalone `deleteSurface(surfaceId)` command (no variable assignment):
    deleteSurface("dashboard-surface-1")

13. Static properties: Arguments annotated with '(static)' in the signatures below MUST be defined as literal values or arrays inline. You CANNOT use a dynamic data binding path (prefixed by $) for these arguments.

14. Required actions: Parameters named 'action' (or annotated in component signatures) are strictly required. You must pass a valid Event (e.g. Event("click")) or function call. If no specific action is described in the user request, you must provide a dummy click event like Event("click") instead of passing null or omitting the parameter.

15. Surface targeting: Output `surface(surfaceId)` to specify or target a user interface surface:
    surface("dashboard-surface-1")
    root = Card(...)

## Positional Component Signatures

Use these exact positional signatures to instantiate components. Do not output property keys:
• Button(label, action (static), style? (static))
  - Description: A button. `Event(name, context)` sends the click back to the agent in the board's answer, with the current values of the inputs on the card; `openUrl` opens an https link.
  - style: Must be one of: 'primary', 'plain'
• Card(title, children)
  - Description: The root of a board widget (id `root`): an optional title and its children. Use it for the one widget a board shows.
• Code(code, language? (static))
  - Description: A code block, shown as text.
• Divider()
  - Description: A hairline between sections.
• Grid(columns (static), children, gap? (static))
  - Description: Equal-width columns, filled row by row. On a phone, 3 or 4 columns drop to 2.
  - gap: Must be one of: 'xs', 'sm', 'md', 'lg'
• Icon(name (static), label, tone? (static))
  - Description: One icon from a fixed set. `label` is what a screen reader says.
  - name: Must be one of: 'check', 'alert', 'info', 'x', 'clock', 'file', 'folder', 'git-branch', 'play', 'star', 'link', 'user', 'bell', 'lock'
  - tone: Must be one of: 'info', 'ok', 'warn', 'error', 'needs'
• Image(url (static), alt)
  - Description: A picture from an https address.
• List(items, max? (static))
  - Description: Rows of things with a state: a title, an optional subtitle and trailing value, a tone pill and an optional https link.
  - items: Array of {title, subtitle?, trailing?, tone?, url?}, usually bound to a data-model path.
  - max: Rows shown before `N more`.
• Metric(label, value, note?)
  - Description: One number with a label and an optional note.
• Pill(text, tone (static))
  - Description: A short state word in a tone.
  - tone: `ok` done or healthy, `info` in progress, `warn` slipping, `error` failed, `needs` the person must act. Must be one of: 'info', 'ok', 'warn', 'error', 'needs'
• Progress(label, value, total, note?, tone? (static))
  - Description: A bar with `value` of `total`, a label and an optional note.
  - tone: Must be one of: 'info', 'ok', 'warn', 'error'
• Select(label, path (static), options (static))
  - Description: A pick-one input bound to `path`; the value is the picked option's `key`.
  - options: List of maps with keys:
    * key
    * label
• Slider(label, path (static), min (static), max (static), step? (static))
  - Description: A number input bound to `path` between `min` and `max`.
• Stack(direction (static), children, gap? (static), align? (static))
  - Description: Lays children out in a row or a column.
  - direction: Must be one of: 'row', 'column'
  - gap: Space between children: xs 4, sm 8 (default), md 12 or lg 16 pixels. Must be one of: 'xs', 'sm', 'md', 'lg'
  - align: Must be one of: 'start', 'center', 'end', 'stretch'
• Table(columns (static), rows, max? (static))
  - Description: Rows under typed columns.
  - columns: List of maps with keys:
    * key
    * label
  - rows: Array of objects keyed by column `key`.
• Text(text, variant? (static))
  - Description: Plain prose, never markup. `title` is a heading for the widget's sections, `muted` a quiet note.
  - variant: Must be one of: 'body', 'title', 'muted'
• TextField(label, path (static), placeholder?, multiline? (static))
  - Description: A text input bound to the data model at `path`. Its value comes back in the board's answer.
• Toggle(label, path (static))
  - Description: An on/off input bound to `path`.

## Positional Function Signatures

Use these exact positional signatures to instantiate check rules or logic functions:
• openUrl(url)
  - Description: Opens an https link in a new tab.

## Catalog Instructions

One surface is one widget. The root is always a Card (id `root`). Keep it small: at most 60 components, one question per widget. State is a tone (`ok`, `info`, `warn`, `error`, `needs`), never a colour word. Put values in the data model with `$/path = value` lines and bind components to them. A Button's `Event(name, {key: value})` comes back to you in `result.blockEdits[blockId]`, with the values of every input on the card, so name the events for what the person decided (`approve`, `retry`). Use `openUrl` for links. Never put markup in a string: text is drawn as text. Use the board's own question blocks for anything the answer depends on; an A2UI widget is for state, quick actions and small forms.

### Examples:

Status list: things with a state, one row each. The tone carries the state, `trailing` the short word, `url` opens the thing. Rows that need the person come first; the Button reports the decision.

<a2ui>
surface("example")
$/runs = [{title: "Deploy staging", subtitle: "waiting on your approval", tone: "needs"}, {title: "Build 412", subtitle: "main, 2 minutes ago", trailing: "Passed", tone: "ok", url: "https://ci.example.com/runs/412"}, {title: "Lint", trailing: "3 warnings", tone: "warn"}]
root = Card("Release checks", [root_children_0, root_children_1])
root_children_0 = List($/runs, 5)
root_children_1 = Stack("row", [root_children_1_children_0, root_children_1_children_1])
root_children_1_children_0 = Button("Approve", Event("approve"), "primary")
root_children_1_children_1 = Button("Hold", Event("hold"))
</a2ui>

Numbers and progress: two headline numbers side by side, then one bar against a goal.

<a2ui>
surface("example")
$/shipped = 31
$/target = 50
root = Card("Orders this week", [root_children_0, root_children_1])
root_children_0 = Grid(2, [root_children_0_children_0, root_children_0_children_1])
root_children_0_children_0 = Metric("Shipped", "31")
root_children_0_children_1 = Metric("Late", "4", "was 1")
root_children_1 = Progress("Shipped", $/shipped, $/target, "8 packing")
</a2ui>

Small form: inputs bound to the data model; the Button sends their values back with the event.

<a2ui>
surface("example")
$/dry = true
$/env = "staging"
$/note = ""
root = Card("Deploy", [root_children_0, root_children_1, root_children_2, root_children_3])
root_children_0 = Select("Environment", "/env", [{key: "staging", label: "Staging"}, {key: "prod", label: "Production"}])
root_children_1 = Toggle("Dry run", "/dry")
root_children_2 = TextField("Note", "/note", _, true)
root_children_3 = Button("Deploy", Event("deploy", {env: $/env, dry: $/dry, note: $/note}), "primary")
</a2ui>
