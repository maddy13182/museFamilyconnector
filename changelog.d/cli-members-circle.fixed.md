Fixed `hub members` to output the circle context: now returns
`{circle_id, circle_name, members}` instead of a bare member list.
Previously it was unclear which circle the members belonged to
(Prem's feedback). CLI 1.1.0 → 1.1.1.
