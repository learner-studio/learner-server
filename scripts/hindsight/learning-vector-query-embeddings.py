"""BizTools adapter: reuse installed Hindsight query encoder without upstream changes."""
import asyncio
import json
import sys
from hindsight_api.engine.embeddings import LocalSTEmbeddings

async def main():
    texts = json.load(sys.stdin)
    model = LocalSTEmbeddings(model_name='BAAI/bge-small-en-v1.5', force_cpu=True)
    await model.initialize()
    print(json.dumps(model.encode_query(texts)))

asyncio.run(main())
