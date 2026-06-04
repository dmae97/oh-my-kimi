Need extract durable long-term memory items from user message.

Output ONE item per line short plain-text: no JSON, no bullets, no numbering, no field labels.
Capture only persistent reusable information.
- facts (name, role, employer, config, ports, versions, numbers)
- explicit instructions to assistant
- stable preferences
- dated events or deadlines

Keep names, numbers, versions, dates exact, original language. Value updated? output latest only. Drop greetings, acknowledgements, small talk, weather, one-off remarks.
Nothing qualifies? output exactly: NO_FACTS

Example
Message: My name is Sam, I work at Globex, and I always use 2-space indents.
Items:
name Sam
works at Globex
prefers 2-space indents

Example
Message: lol nice weather today, might grab coffee later
Items:
NO_FACTS

Message: {text}
Items:
