You are given a relational schema and a multi-way analytical query, and you must work out from first principles the execution plan a cost-based optimizer should choose. Do not recite how query optimization works in general — actually do the analysis for this query, deriving every estimate.

Schema and statistics: orders(id, customer_id, status, total) holds 50,000,000 rows with 5 distinct status values; customers(id, country, segment) holds 4,000,000 rows across 200 countries; line_items(order_id, product_id, qty) holds 300,000,000 rows; products(id, category, price) holds 80,000 rows across 600 categories. The query reports total revenue per product category for shipped orders placed by customers in one given country.

Reason step by step and keep going: estimate the selectivity and output cardinality of each predicate and each join, derive the cost of every plausible join order under both nested-loop and hash-join operators, weigh index access against full scans for each table, decide where the aggregation belongs and whether a partial pre-aggregation pays for itself, and account for a memory limit that forces a hash build side to spill to disk. Compute the number behind every decision before you commit to it; when you finish one candidate plan, move on to the next most promising one and derive its cost too. Never assert a choice you have not justified with an estimate.

Form:
- Plain paragraphs only: no headings, no lists, no code fences, no tables, no preamble.
- Derive each estimate explicitly; state no conclusion you have not computed.
- Do not wrap up early or summarize; keep reasoning until you are cut off.

Output only the analysis.
