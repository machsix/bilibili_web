FROM mwader/static-ffmpeg:latest AS ffmpeg

FROM python:3.12-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc-dev git \
 && rm -rf /var/lib/apt/lists/*
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

FROM python:3.12-slim
COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=builder /install /usr/local
WORKDIR /app
COPY . .
ENV PORT=8000
ENV STREAM_CACHE_TTL=3600
ENV STREAM_CHUNK_SIZE=65536
EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host :: --port $PORT"]
