---
"@callstack/tracesift": patch
---

add a whole-recording view: one row per function, ranked by inclusive time

Every CPU view in the tool was scoped to a task, which is what lets a figure
carry a start offset — but it also means a function called from several tasks
never appears as itself, so a figure measured in another flame-graph tool
could not be found here at all. The results page now ends with the recording
merged into one row per function, showing total and self time and a share of
the profile. Ranking is by inclusive time, so a component that delegates all
its work ranks on what it costs rather than disappearing: on the local trace
`useSearchTypeMenuSections` (1045 ms, none of it its own) now sits ten rows
above `getChildTransactions` (205 ms).
