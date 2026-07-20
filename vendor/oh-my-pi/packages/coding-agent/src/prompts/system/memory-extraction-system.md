Extract durable, long-term memory items from the user message below.

Output ONE item per line as a short plain-text statement: no JSON, no bullets, no numbering, no field labels.
Capture only persistent, reusable information:
- facts (name, role, employer, config, ports, versions, numbers)
- explicit instructions to the assistant
- stable preferences
- dated events or deadlines

Keep names, numbers, versions, and dates exact, in the message's original language. When a value is updated, output only the latest value. Ignore greetings, acknowledgements, small talk, weather, and one-off remarks.
If nothing qualifies, output exactly: NO_FACTS

Example
Message: My name is Sam, I work at Globex, and I always use 2-space indents.
Items:
name is Sam
works at Globex
prefers 2-space indents

Example
Message: lol nice weather today, might grab a coffee later
Items:
NO_FACTS

Message: {text}
Items:
