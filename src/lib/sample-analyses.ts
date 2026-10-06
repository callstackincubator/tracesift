import type { AnalysisRecord } from "./analysis";

/**
 * Bundled reports are static, sanitized UI data — never an uploaded profile.
 * The CPU sample is genuine output: a profile shaped like the scenario it
 * describes, run through the same task extraction and card selection an upload
 * goes through, with every frame resolved by the classification rules so no
 * model was involved in producing it.
 */
export const CPU_SAMPLE_ANALYSIS: AnalysisRecord = {
  id: "sample-cpu-hermes-date-formatting",
  createdAt: 0,
  profileType: "cpu",
  title: "Hermes CPU profile sample",
  saved: false,
  dir: "",
  totalMs: 8128,
  // Task boundaries the tracer measured, so the durations and start offsets
  // below are wall clock rather than a sum over scattered calls.
  taskCards: {
    "cards": [
      {
        "id": "task-0",
        "taskIndex": 0,
        "startMs": 1201,
        "durationMs": 2111,
        "boundaries": "measured",
        "headline": "_onFocus \u2014 a 2111 ms task 1.20 s into the recording",
        "pathline": "_onFocus \u203a getUserByUserName \u203a _compareUsers",
        "shapeline": "74% in datePrototypeToLocaleStringHelper \u00b7 8 calls, longest 196 ms",
        "percentOfProfile": 25.97,
        "boundaryFrames": [
          {
            "name": "_onFocus",
            "location": "app/screens/UserList.js:142:1",
            "nodeId": "0.0",
            "totalMs": 2111,
            "selfMs": 0,
            "invocations": 1,
            "longestCallMs": 2111,
            "shapeText": "ran once in this task \u00b7 2.11 s total",
            "culprits": [
              {
                "name": "datePrototypeToLocaleStringHelper",
                "frameClass": "native",
                "selfMs": 1568,
                "totalMs": 1568,
                "invocations": 8,
                "longestCallMs": 196,
                "shapeText": "ran 8 times inside this frame \u00b7 1.57 s total \u00b7 longest single call 196 ms",
                "nodeId": "0.0.0.0.0.0",
                "callers": ["_onFocus", "getUserByUserName", "_compareUsers"]
              },
              {
                "name": "jsonParse",
                "frameClass": "native",
                "selfMs": 420,
                "totalMs": 420,
                "invocations": 1,
                "longestCallMs": 420,
                "shapeText": "ran once inside this frame \u00b7 420 ms total",
                "nodeId": "0.0.0.1",
                "callers": ["_onFocus", "getUserByUserName"]
              },
              {
                "name": "getUserByUserName",
                "location": "app/screens/UserList.js:89:1",
                "frameClass": "app",
                "selfMs": 81,
                "totalMs": 2111,
                "invocations": 1,
                "longestCallMs": 2111,
                "shapeText": "ran once inside this frame \u00b7 2.11 s total",
                "nodeId": "0.0.0",
                "callers": ["_onFocus"]
              }
            ]
          }
        ],
        "boundaryTailCount": 0,
        "boundaryTailMs": 0,
        "outsideBoundariesMs": 0,
        "culprits": [
          {
            "name": "datePrototypeToLocaleStringHelper",
            "frameClass": "native",
            "selfMs": 1568,
            "totalMs": 1568,
            "invocations": 8,
            "longestCallMs": 196,
            "shapeText": "ran 8 times in this task \u00b7 1.57 s total \u00b7 longest single call 196 ms",
            "nodeId": "0.0.0.0.0.0",
            "callers": ["_onFocus", "getUserByUserName", "_compareUsers"],
            "reachedVia": [
              "_onFocus (app/screens/UserList.js:142:1)",
              "getUserByUserName (app/screens/UserList.js:89:1)",
              "arrayPrototypeSort (native array.js:1:1)",
              "_compareUsers (app/screens/UserList.js:95:1)",
              "datePrototypeToLocaleStringHelper (native date.js:1:1)"
            ],
            "hotPath": [
              "datePrototypeToLocaleStringHelper (native date.js:1:1)"
            ]
          },
          {
            "name": "jsonParse",
            "frameClass": "native",
            "selfMs": 420,
            "totalMs": 420,
            "invocations": 1,
            "longestCallMs": 420,
            "shapeText": "ran once in this task \u00b7 420 ms total",
            "nodeId": "0.0.0.1",
            "callers": ["_onFocus", "getUserByUserName"],
            "reachedVia": [
              "_onFocus (app/screens/UserList.js:142:1)",
              "getUserByUserName (app/screens/UserList.js:89:1)",
              "jsonParse (native json.js:1:1)"
            ],
            "hotPath": [
              "jsonParse (native json.js:1:1)"
            ]
          },
          {
            "name": "getUserByUserName",
            "location": "app/screens/UserList.js:89:1",
            "frameClass": "app",
            "selfMs": 81,
            "totalMs": 2111,
            "invocations": 1,
            "longestCallMs": 2111,
            "shapeText": "ran once in this task \u00b7 2.11 s total",
            "nodeId": "0.0.0",
            "callers": ["_onFocus"],
            "reachedVia": [
              "_onFocus (app/screens/UserList.js:142:1)",
              "getUserByUserName (app/screens/UserList.js:89:1)"
            ],
            "hotPath": [
              "getUserByUserName (app/screens/UserList.js:89:1)",
              "arrayPrototypeSort (native array.js:1:1)",
              "_compareUsers (app/screens/UserList.js:95:1)",
              "datePrototypeToLocaleStringHelper (native date.js:1:1)"
            ]
          }
        ],
        "tree": {
          "id": "0",
          "name": "(root)",
          "frameClass": "native",
          "totalMs": 2111,
          "selfMs": 0,
          "invocations": 1,
          "children": [
            {
              "id": "0.0",
              "name": "_onFocus",
              "location": "app/screens/UserList.js:142:1",
              "frameClass": "app",
              "totalMs": 2111,
              "selfMs": 0,
              "invocations": 1,
              "children": [
                {
                  "id": "0.0.0",
                  "name": "getUserByUserName",
                  "location": "app/screens/UserList.js:89:1",
                  "frameClass": "app",
                  "totalMs": 2111,
                  "selfMs": 81,
                  "invocations": 1,
                  "children": [
                    {
                      "id": "0.0.0.0",
                      "name": "arrayPrototypeSort",
                      "frameClass": "native",
                      "totalMs": 1610,
                      "selfMs": 42,
                      "invocations": 1,
                      "children": [
                        {
                          "id": "0.0.0.0.0",
                          "name": "_compareUsers",
                          "location": "app/screens/UserList.js:95:1",
                          "frameClass": "app",
                          "totalMs": 1568,
                          "selfMs": 0,
                          "invocations": 8,
                          "children": [
                            {
                              "id": "0.0.0.0.0.0",
                              "name": "datePrototypeToLocaleStringHelper",
                              "frameClass": "native",
                              "totalMs": 1568,
                              "selfMs": 1568,
                              "invocations": 8,
                              "children": []
                            }
                          ]
                        }
                      ]
                    },
                    {
                      "id": "0.0.0.1",
                      "name": "jsonParse",
                      "frameClass": "native",
                      "totalMs": 420,
                      "selfMs": 420,
                      "invocations": 1,
                      "children": []
                    }
                  ]
                }
              ]
            }
          ]
        },
        "timeline": {
          "boxes": [
            {
              "depth": 0,
              "name": "_onFocus",
              "location": "app/screens/UserList.js:142:1",
              "frameClass": "app",
              "startMs": 0,
              "durationMs": 2111,
              "selfMs": 0,
              "nodeId": "0.0"
            },
            {
              "depth": 1,
              "name": "getUserByUserName",
              "location": "app/screens/UserList.js:89:1",
              "frameClass": "app",
              "startMs": 0,
              "durationMs": 2111,
              "selfMs": 543,
              "nodeId": "0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 87,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 289,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 490,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 691,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 892,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 1093,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 1294,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            },
            {
              "depth": 2,
              "name": "_compareUsers",
              "location": "app/screens/UserList.js:95:1",
              "frameClass": "app",
              "startMs": 1495,
              "durationMs": 196,
              "selfMs": 196,
              "nodeId": "0.0.0.0.0"
            }
          ],
          "durationMs": 2111,
          "coveredMs": 2111,
          "rows": 3,
          "kept": [
            "app"
          ],
          "omittedBoxCount": 0,
          "omittedBoxMs": 0
        },
        "subtreeFunctionCount": 6,
        "confidence": "ok",
        "segments": [
          {
            "id": "0.0.0.0.0.0",
            "title": "datePrototypeToLocaleStringHelper",
            "headline": "datePrototypeToLocaleStringHelper spent 1568 ms in total time",
            "totalMs": 1568,
            "selfMs": 1568,
            "percentOfProfile": 74.28,
            "callSites": 1,
            "nameInherited": false,
            "selfShape": "body",
            "frameworkOnly": false,
            "confidence": "ok",
            "reachedVia": [
              "_onFocus (app/screens/UserList.js:142:1)",
              "getUserByUserName (app/screens/UserList.js:89:1)",
              "arrayPrototypeSort (native array.js:1:1)",
              "_compareUsers (app/screens/UserList.js:95:1)",
              "datePrototypeToLocaleStringHelper (native date.js:1:1)"
            ],
            "hotPath": [
              "datePrototypeToLocaleStringHelper (native date.js:1:1)"
            ],
            "highlights": [],
            "children": [],
            "repeated": [],
            "subtreeFunctionCount": 0
          },
          {
            "id": "0.0.0.1",
            "title": "jsonParse",
            "headline": "jsonParse spent 420 ms in total time",
            "totalMs": 420,
            "selfMs": 420,
            "percentOfProfile": 19.9,
            "callSites": 1,
            "nameInherited": false,
            "selfShape": "body",
            "frameworkOnly": false,
            "confidence": "ok",
            "reachedVia": [
              "_onFocus (app/screens/UserList.js:142:1)",
              "getUserByUserName (app/screens/UserList.js:89:1)",
              "jsonParse (native json.js:1:1)"
            ],
            "hotPath": [
              "jsonParse (native json.js:1:1)"
            ],
            "highlights": [],
            "children": [],
            "repeated": [],
            "subtreeFunctionCount": 0
          }
        ]
      },
      {
        "id": "task-1",
        "taskIndex": 1,
        "startMs": 5001,
        "durationMs": 655,
        "boundaries": "measured",
        "headline": "_onChange \u2014 a 655 ms task 5.00 s into the recording",
        "pathline": "_onChange \u203a formatDate",
        "shapeline": "64% in intlDateTimeFormatFormat \u00b7 12 calls, longest 35 ms",
        "percentOfProfile": 8.06,
        "boundaryFrames": [
          {
            "name": "_onChange",
            "location": "app/screens/UserList.js:168:1",
            "nodeId": "0.0",
            "totalMs": 655,
            "selfMs": 0,
            "invocations": 1,
            "longestCallMs": 655,
            "shapeText": "ran once in this task \u00b7 655 ms total",
            "culprits": [
              {
                "name": "intlDateTimeFormatFormat",
                "frameClass": "native",
                "selfMs": 420,
                "totalMs": 420,
                "invocations": 12,
                "longestCallMs": 35,
                "shapeText": "ran 12 times inside this frame \u00b7 420 ms total \u00b7 longest single call 35 ms",
                "nodeId": "0.0.0.0.0",
                "callers": ["_onChange", "formatDate"]
              },
              {
                "name": "stringPrototypeLocaleCompare",
                "frameClass": "native",
                "selfMs": 75,
                "totalMs": 75,
                "invocations": 1,
                "longestCallMs": 75,
                "shapeText": "ran once inside this frame \u00b7 75 ms total",
                "nodeId": "0.0.1.0.0",
                "callers": ["_onChange", "_temp3"]
              },
              {
                "name": "formatDate",
                "location": "app/lib/format.js:13:1",
                "frameClass": "app",
                "selfMs": 60,
                "totalMs": 535,
                "invocations": 1,
                "longestCallMs": 535,
                "shapeText": "ran once inside this frame \u00b7 535 ms total",
                "nodeId": "0.0.0.0",
                "callers": ["_onChange"]
              },
              {
                "name": "intlDateTimeFormatConstructor",
                "frameClass": "native",
                "selfMs": 55,
                "totalMs": 55,
                "invocations": 1,
                "longestCallMs": 55,
                "shapeText": "ran once inside this frame \u00b7 55 ms total",
                "nodeId": "0.0.0.0.1",
                "callers": ["_onChange", "formatDate"]
              },
              {
                "name": "_temp3",
                "location": "app/screens/UserList.js:174:1",
                "frameClass": "app",
                "selfMs": 45,
                "totalMs": 120,
                "invocations": 1,
                "longestCallMs": 120,
                "shapeText": "ran once inside this frame \u00b7 120 ms total",
                "nodeId": "0.0.1.0",
                "callers": ["_onChange"]
              }
            ]
          }
        ],
        "boundaryTailCount": 0,
        "boundaryTailMs": 0,
        "outsideBoundariesMs": 0,
        "culprits": [
          {
            "name": "intlDateTimeFormatFormat",
            "frameClass": "native",
            "selfMs": 420,
            "totalMs": 420,
            "invocations": 12,
            "longestCallMs": 35,
            "shapeText": "ran 12 times in this task \u00b7 420 ms total \u00b7 longest single call 35 ms",
            "nodeId": "0.0.0.0.0",
            "callers": ["_onChange", "formatDate"],
            "reachedVia": [
              "_onChange (app/screens/UserList.js:168:1)",
              "arrayPrototypeMap (native array.js:1:1)",
              "formatDate (app/lib/format.js:13:1)",
              "intlDateTimeFormatFormat (native date.js:1:1)"
            ],
            "hotPath": [
              "intlDateTimeFormatFormat (native date.js:1:1)"
            ]
          },
          {
            "name": "stringPrototypeLocaleCompare",
            "frameClass": "native",
            "selfMs": 75,
            "totalMs": 75,
            "invocations": 1,
            "longestCallMs": 75,
            "shapeText": "ran once in this task \u00b7 75 ms total",
            "nodeId": "0.0.1.0.0",
            "callers": ["_onChange", "_temp3"],
            "reachedVia": [
              "_onChange (app/screens/UserList.js:168:1)",
              "arrayPrototypeSort (native array.js:1:1)",
              "_temp3 (app/screens/UserList.js:174:1)",
              "stringPrototypeLocaleCompare (native string.js:1:1)"
            ],
            "hotPath": [
              "stringPrototypeLocaleCompare (native string.js:1:1)"
            ]
          },
          {
            "name": "formatDate",
            "location": "app/lib/format.js:13:1",
            "frameClass": "app",
            "selfMs": 60,
            "totalMs": 535,
            "invocations": 1,
            "longestCallMs": 535,
            "shapeText": "ran once in this task \u00b7 535 ms total",
            "nodeId": "0.0.0.0",
            "callers": ["_onChange"],
            "reachedVia": [
              "_onChange (app/screens/UserList.js:168:1)",
              "arrayPrototypeMap (native array.js:1:1)",
              "formatDate (app/lib/format.js:13:1)"
            ],
            "hotPath": [
              "formatDate (app/lib/format.js:13:1)",
              "intlDateTimeFormatFormat (native date.js:1:1)"
            ]
          },
          {
            "name": "intlDateTimeFormatConstructor",
            "frameClass": "native",
            "selfMs": 55,
            "totalMs": 55,
            "invocations": 1,
            "longestCallMs": 55,
            "shapeText": "ran once in this task \u00b7 55 ms total",
            "nodeId": "0.0.0.0.1",
            "callers": ["_onChange", "formatDate"],
            "reachedVia": [
              "_onChange (app/screens/UserList.js:168:1)",
              "arrayPrototypeMap (native array.js:1:1)",
              "formatDate (app/lib/format.js:13:1)",
              "intlDateTimeFormatConstructor (native date.js:1:1)"
            ],
            "hotPath": [
              "intlDateTimeFormatConstructor (native date.js:1:1)"
            ]
          },
          {
            "name": "_temp3",
            "location": "app/screens/UserList.js:174:1",
            "frameClass": "app",
            "selfMs": 45,
            "totalMs": 120,
            "invocations": 1,
            "longestCallMs": 120,
            "shapeText": "ran once in this task \u00b7 120 ms total",
            "nodeId": "0.0.1.0",
            "callers": ["_onChange"],
            "reachedVia": [
              "_onChange (app/screens/UserList.js:168:1)",
              "arrayPrototypeSort (native array.js:1:1)",
              "_temp3 (app/screens/UserList.js:174:1)"
            ],
            "hotPath": [
              "_temp3 (app/screens/UserList.js:174:1)",
              "stringPrototypeLocaleCompare (native string.js:1:1)"
            ]
          }
        ],
        "tree": {
          "id": "0",
          "name": "(root)",
          "frameClass": "native",
          "totalMs": 655,
          "selfMs": 0,
          "invocations": 1,
          "children": [
            {
              "id": "0.0",
              "name": "_onChange",
              "location": "app/screens/UserList.js:168:1",
              "frameClass": "app",
              "totalMs": 655,
              "selfMs": 0,
              "invocations": 1,
              "children": [
                {
                  "id": "0.0.0",
                  "name": "arrayPrototypeMap",
                  "frameClass": "native",
                  "totalMs": 535,
                  "selfMs": 0,
                  "invocations": 1,
                  "children": [
                    {
                      "id": "0.0.0.0",
                      "name": "formatDate",
                      "location": "app/lib/format.js:13:1",
                      "frameClass": "app",
                      "totalMs": 535,
                      "selfMs": 60,
                      "invocations": 1,
                      "children": [
                        {
                          "id": "0.0.0.0.0",
                          "name": "intlDateTimeFormatFormat",
                          "frameClass": "native",
                          "totalMs": 420,
                          "selfMs": 420,
                          "invocations": 12,
                          "children": []
                        },
                        {
                          "id": "0.0.0.0.1",
                          "name": "intlDateTimeFormatConstructor",
                          "frameClass": "native",
                          "totalMs": 55,
                          "selfMs": 55,
                          "invocations": 1,
                          "children": []
                        }
                      ]
                    }
                  ]
                },
                {
                  "id": "0.0.1",
                  "name": "arrayPrototypeSort",
                  "frameClass": "native",
                  "totalMs": 120,
                  "selfMs": 0,
                  "invocations": 1,
                  "children": [
                    {
                      "id": "0.0.1.0",
                      "name": "_temp3",
                      "location": "app/screens/UserList.js:174:1",
                      "frameClass": "app",
                      "totalMs": 120,
                      "selfMs": 45,
                      "invocations": 1,
                      "children": [
                        {
                          "id": "0.0.1.0.0",
                          "name": "stringPrototypeLocaleCompare",
                          "frameClass": "native",
                          "totalMs": 75,
                          "selfMs": 75,
                          "invocations": 1,
                          "children": []
                        }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        },
        "timeline": {
          "boxes": [
            {
              "depth": 0,
              "name": "_onChange",
              "location": "app/screens/UserList.js:168:1",
              "frameClass": "app",
              "startMs": 0,
              "durationMs": 655,
              "selfMs": 0,
              "nodeId": "0.0"
            },
            {
              "depth": 1,
              "name": "formatDate",
              "location": "app/lib/format.js:13:1",
              "frameClass": "app",
              "startMs": 0,
              "durationMs": 535,
              "selfMs": 535,
              "nodeId": "0.0.0.0"
            },
            {
              "depth": 1,
              "name": "_temp3",
              "location": "app/screens/UserList.js:174:1",
              "frameClass": "app",
              "startMs": 535,
              "durationMs": 120,
              "selfMs": 120,
              "nodeId": "0.0.1.0"
            }
          ],
          "durationMs": 655,
          "coveredMs": 655,
          "rows": 2,
          "kept": [
            "app"
          ],
          "omittedBoxCount": 0,
          "omittedBoxMs": 0
        },
        "subtreeFunctionCount": 8,
        "confidence": "ok"
      }
    ],
    "boundaries": "measured",
    "noLongTasks": false,
    "classesDegraded": false,
    "durationMs": 8128,
    "taskCount": 2,
    "omittedTaskCount": 0,
    "omittedTaskMs": 0
  },
  cards: [],
  hotspots: [],
  reactIssues: [],
  prompts: {},
  // Every frame here resolved from the classification rules, so no model ran
  // and nothing was spent producing this report.
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
  promptUsage: {},
};

export const REACT_SAMPLE_ANALYSIS: AnalysisRecord = {
  id: "sample-react-heavy-activity-heatmap",
  createdAt: 0,
  profileType: "react",
  title: "React component profile sample",
  saved: false,
  dir: "",
  totalMs: 172.964,
  hotspots: [],
  // Built by `react-cards.ts` from `sample-profiles/react/react-profile-2.json`.
  // The model-selected engine reported the same component, the same 124.8 ms
  // and the same 73.5% for 20,419 tokens; this is the measured pass over the
  // same recording. Note `causesRecorded: false` — that profile was captured
  // without "Record why each component rendered", so the sample also shows how
  // the cards read when render reasons are unavailable.
  reactCards: {
    "cards": [
      {
        "id": "react-commit-1-1",
        "rootId": 1,
        "commitIndex": 1,
        "startMs": 1737.9,
        "durationMs": 169.7,
        "percentOfRender": 98.1,
        "severity": "high",
        "shape": "single",
        "headline": "HeavyActivityHeatmap spent 124.8 ms rendering in a 169.7 ms commit",
        "shapeline": "74% of the commit in one component · 329 components rendered",
        "causeline": "why each component rendered was not recorded in this profile",
        "renderedCount": 329,
        "summedSelfMs": 146.9,
        "unattributedMs": 22.8,
        "effectDurationMs": 0.9,
        "passiveEffectDurationMs": 0.3,
        "priority": "Immediate",
        "updaters": [
          "BaseNavigationContainer"
        ],
        "culprits": [
          {
            "componentId": "1:728",
            "component": "HeavyActivityHeatmap",
            "componentClass": "app",
            "selfMs": 124.8,
            "percentOfCommit": 73.5,
            "cause": "unknown",
            "changedProps": [],
            "changedHooks": [],
            "compiledWithForget": true,
            "sourceHint": null,
            "path": [
              "DetailsScreen",
              "…",
              "View",
              "ScrollView",
              "HeavyActivityHeatmap"
            ],
            "evidence": "HeavyActivityHeatmap used 124.8 ms self time, 73.5% of a 169.7 ms over-budget React render."
          },
          {
            "componentId": "1:706",
            "component": "Route(explore-details)",
            "componentClass": "library",
            "selfMs": 2.2,
            "percentOfCommit": 1.3,
            "cause": "unknown",
            "changedProps": [],
            "changedHooks": [],
            "compiledWithForget": false,
            "sourceHint": null,
            "path": [
              "DebugContainer",
              "…",
              "EnsureSingleNavigator",
              "StaticContainer",
              "Route(explore-details)"
            ],
            "evidence": "Route(explore-details) used 2.2 ms self time, 1.3% of a 169.7 ms over-budget React render."
          }
        ],
        "culpritTailCount": 327,
        "culpritTailMs": 19.9,
        "causes": [
          {
            "cause": "unknown",
            "count": 329,
            "selfMs": 146.9
          }
        ],
        "wasted": null,
        "confidence": "low",
        "pathline": "DetailsScreen › … › View › ScrollView › HeavyActivityHeatmap",
        "updaterline": "update scheduled by BaseNavigationContainer"
      }
    ],
    "budgetMs": 16,
    "roots": [
      {
        "rootId": 1,
        "rootName": "main(RootComponent)",
        "commitCount": 4,
        "totalRenderMs": 173,
        "peakCommitMs": 169.7
      }
    ],
    "commitCount": 4,
    "commitsOverBudget": 1,
    "noOverBudgetCommits": false,
    "totalRenderMs": 173,
    "peakCommitMs": 169.7,
    "omittedCardCount": 0,
    "omittedCardMs": 0,
    "components": [
      {
        "componentId": "1:728",
        "component": "HeavyActivityHeatmap",
        "componentClass": "app",
        "renders": 1,
        "totalSelfMs": 124.8,
        "maxSelfMs": 124.8,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 124.8
          }
        ]
      },
      {
        "componentId": "1:706",
        "component": "Route(explore-details)",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 2.2,
        "maxSelfMs": 2.2,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 2.2
          }
        ]
      },
      {
        "componentId": "1:16",
        "component": "BaseNavigationContainer",
        "componentClass": "library",
        "renders": 2,
        "totalSelfMs": 1.6,
        "maxSelfMs": 0.8,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 2,
            "selfMs": 1.6
          }
        ]
      },
      {
        "componentId": "1:671",
        "component": "SceneView",
        "componentClass": "library",
        "renders": 2,
        "totalSelfMs": 1.1,
        "maxSelfMs": 0.6,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 2,
            "selfMs": 1.1
          }
        ]
      },
      {
        "componentId": "1:80",
        "component": "NativeStackNavigator",
        "componentClass": "app",
        "renders": 1,
        "totalSelfMs": 0.9,
        "maxSelfMs": 0.9,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.9
          }
        ]
      },
      {
        "componentId": "1:38",
        "component": "Content",
        "componentClass": "app",
        "renders": 1,
        "totalSelfMs": 0.8,
        "maxSelfMs": 0.8,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.8
          }
        ]
      },
      {
        "componentId": "1:715",
        "component": "DetailsScreen",
        "componentClass": "app",
        "renders": 1,
        "totalSelfMs": 0.8,
        "maxSelfMs": 0.8,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.8
          }
        ]
      },
      {
        "componentId": "1:100",
        "component": "SceneView",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.6,
        "maxSelfMs": 0.6,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.6
          }
        ]
      },
      {
        "componentId": "1:574",
        "component": "SceneView",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.6,
        "maxSelfMs": 0.6,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.6
          }
        ]
      },
      {
        "componentId": "1:676",
        "component": "ScreenStackItem",
        "componentClass": "library",
        "renders": 2,
        "totalSelfMs": 0.5,
        "maxSelfMs": 0.3,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 2,
            "selfMs": 0.5
          }
        ]
      },
      {
        "componentId": "1:12",
        "component": "NavigationContainerInner",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.5,
        "maxSelfMs": 0.5,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.5
          }
        ]
      },
      {
        "componentId": "1:683",
        "component": "Animated(Anonymous)",
        "componentClass": "library",
        "renders": 2,
        "totalSelfMs": 0.4,
        "maxSelfMs": 0.2,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 2,
            "selfMs": 0.4
          }
        ]
      },
      {
        "componentId": "1:678",
        "component": "InnerScreen",
        "componentClass": "app",
        "renders": 2,
        "totalSelfMs": 0.4,
        "maxSelfMs": 0.2,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 2,
            "selfMs": 0.4
          }
        ]
      },
      {
        "componentId": "1:40",
        "component": "NavigationContent",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.4,
        "maxSelfMs": 0.4,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.4
          }
        ]
      },
      {
        "componentId": "1:53",
        "component": "SceneView",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.4,
        "maxSelfMs": 0.4,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.4
          }
        ]
      },
      {
        "componentId": "1:699",
        "component": "SceneView",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.3,
        "maxSelfMs": 0.3,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.3
          }
        ]
      },
      {
        "componentId": "1:602",
        "component": "SceneView",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.3,
        "maxSelfMs": 0.3,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.3
          }
        ]
      },
      {
        "componentId": "1:105",
        "component": "ScreenStackItem",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.3,
        "maxSelfMs": 0.3,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.3
          }
        ]
      },
      {
        "componentId": "1:579",
        "component": "ScreenStackItem",
        "componentClass": "library",
        "renders": 1,
        "totalSelfMs": 0.3,
        "maxSelfMs": 0.3,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 1,
            "selfMs": 0.3
          }
        ]
      },
      {
        "componentId": "1:23",
        "component": "EnsureSingleNavigator",
        "componentClass": "library",
        "renders": 2,
        "totalSelfMs": 0.2,
        "maxSelfMs": 0.1,
        "wastedRenders": 0,
        "causes": [
          {
            "cause": "unknown",
            "count": 2,
            "selfMs": 0.2
          }
        ]
      }
    ],
    "repeats": [],
    "causesRecorded": false,
    "unnamedFiberCount": 0
  },
  reactIssues: [],
  prompts: {},
  // Every figure here resolved from arithmetic over the export, so no model ran
  // and nothing was spent producing this report.
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 },
  promptUsage: {},
};

export const REACT_SAMPLE_SUMMARY = {
  rootCount: 1, commitCount: 4, totalCommitRenderDurationMs: 173, peakCommitDurationMs: 169.7,
  commitsOverBudget: 1, omittedEvidenceCommitCount: 0, frameBudgetMs: 16,
};
