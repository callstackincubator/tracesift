---
"@callstack/tracesift": patch
---

Record the tab that is on screen, not the first one Chrome lists.

`record launch` hands the browser to a person, and signing in leaves consent popups and second tabs behind. Chrome lists a newly opened background tab first, so the recorder attached to it and produced a trace of a page nobody was looking at, with nothing to say anything had gone wrong. It now picks the visible page, which a background tab is not whichever application holds the OS focus, and uses window focus only to choose between two windows that are both showing a page.
