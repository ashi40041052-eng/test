#!/bin/bash
# Re-records the real API responses used by the related-capture tests (DESIGN-v3.md section 10).
# Usage: bash test/record-fixtures.sh   (needs network; gh optional)
set -e
D="$(cd "$(dirname "$0")" && pwd)/fixtures/related"
mkdir -p "$D"
fx() { curl -fsS "https://api.fxtwitter.com/2/thread/$1" | python3 -m json.tool --indent 1 > "$D/$2"; }
fx 2110552871565660462 fx2-thread-c07e399d.json
fx 2110763835175153885 fx2-thread-a27279bf.json
fx 2110574328156971471 fx2-thread-84c52ab8.json
fx 2110755123748340030 fx2-thread-06fd91fe.json
fx 2110164449470652678 fx2-thread-4aeb4268.json
fx 2110727758884352474 fx2-thread-6ab719ad.json
curl -fsS https://api.fxtwitter.com/2/status/2110164449470652678 | python3 -m json.tool --indent 1 > "$D/fx2-status-4aeb4268.json"
curl -fsS https://api.github.com/repos/BuilderIO/agent-native > "$D/gh-repo-agent-native.json"
curl -fsS https://api.github.com/repos/BuilderIO/agent-native/readme > "$D/gh-readme-agent-native.json"
curl -fsS https://huggingface.co/api/models/fishaudio/drama-3 > "$D/hf-model-drama-3.json"
curl -fsS https://huggingface.co/fishaudio/drama-3/raw/main/README.md > "$D/hf-readme-drama-3.md"
curl -fsS "https://export.arxiv.org/api/query?id_list=1706.03762" > "$D/arxiv-query-sample.xml"
curl -fsS "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=json" > "$D/yt-oembed-sample.json"
