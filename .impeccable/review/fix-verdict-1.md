# First fix verdict

Disposition: fix. Same reviewer; only the original two material fixes were scored. All nine captures valid.

| Finding | Score | Evidence |
| --- | --- | --- |
| Return and focus | partial | Stable A1281×720/9999-record case retains scrollTop601024.3125/cardtop251.10848999; close and deep End/Delete leave BODY focus. Cross-layout anchor remains unverified. |
| Narrow B keyboard path | partial | At100 records, initial focus, inert, Tab wrap and Esc return all pass; desktop remains nonmodal. At9999 records, closing still shares Finding1 restore failure. |

Remaining reviewer list: complete restore only after target card is mounted, no ancestor is inert and actual focus matches; validate high-data A close, End/Delete neighbor, narrow B close and geometry-change anchor. Preserve the already resolved positional and modal-isolation behavior. No new whole-surface review.
