#!/usr/bin/env bash
set -euo pipefail

web_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

silent_video="$web_dir/public/videos/kakure-prime-final-silent.webm"
mp4_output="$web_dir/public/videos/kakure-prime-pitch.mp4"
webm_output="$web_dir/public/videos/kakure-prime-pitch.webm"

if [[ ! -f "$silent_video" ]]; then
  echo "Missing $silent_video. Run: pnpm exec playwright test or node scripts/record-final-pitch.mjs" >&2
  exit 1
fi

edge-tts \
  --voice en-US-AndrewMultilingualNeural \
  --rate=-2% \
  --pitch=-2Hz \
  --file "$web_dir/scripts/pitch-narration.txt" \
  --write-media "$tmp_dir/narration.mp3" \
  --write-subtitles "$tmp_dir/narration.srt"

sed -i \
  -e 's/Kah-koo-reh/Kakure/g' \
  -e 's/Pre Stocks/PreStocks/g' \
  -e 's/Pith/Pyth/g' \
  -e 's/Mee-tee-or-ah/Meteora/g' \
  -e 's/Groth sixteen/Groth16/g' \
  -e 's/Frost/FROST/g' \
  "$tmp_dir/narration.srt"

escaped_subtitles="${tmp_dir//\\//}"
escaped_subtitles="${escaped_subtitles//:/\\:}"
escaped_subtitles="${escaped_subtitles//\//\\/}"
sed "s|__KAKURE_SUBTITLES__|$escaped_subtitles|" \
  "$web_dir/scripts/pitch-filter.ffmpeg" > "$tmp_dir/filter.ffmpeg"

ffmpeg -y \
  -i "$silent_video" \
  -i "$tmp_dir/narration.mp3" \
  -filter_script:v "$tmp_dir/filter.ffmpeg" \
  -map 0:v:0 -map 1:a:0 \
  -c:v libx264 -preset medium -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 160k -ar 48000 \
  -shortest -movflags +faststart "$mp4_output"

ffmpeg -y \
  -i "$mp4_output" \
  -c:v libvpx-vp9 -crf 32 -b:v 0 -row-mt 1 \
  -c:a libopus -b:a 128k "$webm_output"

echo "Rendered:"
echo "  $mp4_output"
echo "  $webm_output"
