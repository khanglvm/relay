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
