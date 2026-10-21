"""Offline BGE tokenizer only. No model initialization or network access.

Offsets returned to JS are UTF-16 code units into the unchanged source string.
Every resulting slice is encoded independently with truncation disabled; the
480-token ceiling includes special tokens. The character cap only avoids a
second Hindsight split and is never used as evidence of token safety.
"""
import hashlib
import json
import sys
from tokenizers import Tokenizer


def chunk_text(text, tokenizer, max_chars=2500):
    tokenizer.no_truncation()
    tokenizer.no_padding()
    prefix = [0]
    for char in text:
        prefix.append(prefix[-1] + (2 if ord(char) > 0xFFFF else 1))
    chunks = []
    start = 0
    while start < len(text):
        end = min(len(text), start + max_chars)
        encoded = tokenizer.encode(text[start:end], add_special_tokens=True)
        while len(encoded.ids) > 480:
            # Retreat to an actual token boundary; independently re-encode
            # because wordpiece boundaries can change when slicing a word.
            boundaries = [a for a, b in encoded.offsets[1:479] if a > 0]
            if not boundaries:
                raise ValueError('No safe tokenizer boundary')
            end = start + boundaries[-1]
            encoded = tokenizer.encode(text[start:end], add_special_tokens=True)
        if end <= start:
            raise ValueError('Tokenizer made no progress')
        chunks.append({'startOffset': prefix[start], 'endOffset': prefix[end],
                       'tokenCount': len(encoded.ids)})
        start = end
    return chunks


if __name__ == '__main__':
    tokenizer_path = sys.argv[1]
    with open(tokenizer_path, 'rb') as source:
        digest = hashlib.sha256(source.read()).hexdigest()
    tokenizer = Tokenizer.from_file(tokenizer_path)
    payload = json.load(sys.stdin)
    print(json.dumps([{'tokenizerSha256': digest, 'chunks': chunk_text(text, tokenizer)}
                      for text in payload['texts']]))
