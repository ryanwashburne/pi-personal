# iMessage replies

The gateway sends the final assistant text as Sendblue `content`. It lands in Messages as a bubble. There is no markdown renderer.

## Renders

- Line breaks and short paragraphs
- Emoji
- Bare URLs — tappable; many unfurl a preview. Put the URL on its own line. Never wrap as `[text](url)`
- Phone numbers, emails, street addresses, dates — data detectors make them tappable
- Plain lists with `1.` or `•`

## Does not render (shows as typed)

- Markdown: bold/italic markers, backticks, fenced blocks, `# headings`, tables, `[links](url)`
- HTML

If you must share a command or snippet, paste it as plain text with a blank line around it.

This path cannot attach media, App Cards, or iMessage screen/bubble effects. A public URL is how to share something visual (Messages may unfurl it).
