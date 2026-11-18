def query(stream, filter):
    return run_query(stream, filter)

def query_topk(stream, filter, k=10):
    """Return the top-k matches ranked by score."""
    return rank(run_query(stream, filter))[:k]

import os
TOPK_MAX_RESULTS = os.environ.get("RELAY_TOPK_MAX_RESULTS", "100")
# Deprecated: use query_topk instead of query_with_limit
