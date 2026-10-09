# Historical native harness recovery

Historical harness files below are reconstructed copies, not contemporaneously archived working files. Raw result bytes are unchanged. Exact recorded Git source/path and SHA-256 authorize each reconstruction.

The earlier E2C build-time script, first actually executed 60A script, and later 49C race script are distinct. The E2C specimen is a direct copy of the parent archive. All runtime reconstructions are marked by method and verified against their own raw results. No result or failure is rewritten.

| Run | Classification | Script source | Script SHA | Recovery |
| --- | --- | --- | --- | --- |
| wall-capture-1791488191109 | partial harness run | 842c194 | 60a1b59674b4 | hash-matched reconstructed copy |
| wall-capture-1791488458222 | partial harness run | d11ead2 | eb96f8e1983b | hash-matched reconstructed copy |
| wall-capture-1791488505260 | partial harness run | 4b5e1ac | 6c1944ee9606 | hash-matched reconstructed copy |
| wall-capture-1791488575033 | partial harness run | bcafeb3 | 9d17eaa13c33 | hash-matched reconstructed copy |
| wall-capture-1791488713265 | partial harness run | 18964f4 | abd233884f3c | hash-matched reconstructed copy |
| wall-capture-1791488834203 | partial harness run | 9870831 | 02b757c64f57 | hash-matched reconstructed copy |
| wall-capture-1791488917659 | partial harness run | 2328aab | 34f4bb17f88b | hash-matched reconstructed copy |
| wall-capture-1791489019058 | partial harness run | 5685f0e | 450ed7dd512b | hash-matched reconstructed copy |
| wall-capture-1791489125093 | partial harness run | 24a4fbc | b8cedd0d5fe9 | hash-matched reconstructed copy |
| wall-capture-1791489296085 | partial harness run | b7730e4 | 377da3ac4deb | hash-matched reconstructed copy |
| wall-capture-1791489665739 | partial harness run | af0117f | a6c6c4d2af0e | hash-matched reconstructed copy |
| wall-capture-1791489746034 | partial harness run | cbfaf8d | 49c07d1c29bf | hash-matched reconstructed copy |
| wall-capture-1791489892925 | partial harness run | a745ce7 | 49c07d1c29bf | hash-matched reconstructed copy |
| wall-capture-race-1791490083077 | actual product RED | a745ce7 | 49c07d1c29bf | hash-matched reconstructed copy |

`historical-harness-index.json` records the complete SHA-256, Git blob, reconstruction method, helper coverage, raw result hash and unchanged result-copy path. Early runs did not record standalone helper hashes; those entries remain unrecorded instead of receiving invented hashes. Historical per-run configuration snapshots were not captured and cannot be reconstructed from code.

These are partial wall runs plus one actual clipboard race RED. Their successful assertions are not accumulated into a full wall pass.
