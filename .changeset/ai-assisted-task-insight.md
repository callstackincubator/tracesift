---
"tracesift": minor
---

Add an "AI assisted" setting, and an on-demand per-task inference behind it.

Each task card carries an **Explain with AI** button. Pressing it sends that one task — its own timeline against the clock, framework and engine collapsed away, plus the functions that burned its time — to the configured model, which answers with a few short technical bullets saying what the issue is and where it originates. They render above the card's rows, labelled as a reading rather than a measurement, and the card keeps its measured heading. It is a button rather than part of the upload because only some tasks on a page are worth a model call, and the choice of which belongs to the reader.

The copy hand-off for a task that has been read carries the same inference as its first section, above the measured evidence an agent can check it against.

With the setting off, nothing contacts a provider: the settings panel hides the provider, credential and sign-in fields, frame classification falls back to its rules, no card offers the button, and JavaScript CPU profiles still produce full measured cards. React profile analysis is unavailable, because every issue it reports is the analyzer's reading of a commit and there is no deterministic engine behind it.
