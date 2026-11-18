FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
# git is NOT in the slim image and every analysis step shells out to it.
# ca-certificates for OpenRouter/GitHub TLS calls.
RUN apt-get update  && apt-get install -y --no-install-recommends git ca-certificates  && rm -rf /var/lib/apt/lists/*
WORKDIR /srv/pipeline

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY prompts ./prompts
COPY scripts ./scripts
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

RUN useradd --create-home --uid 10001 pipeline && chmod -R a+rwX /srv/pipeline
USER pipeline
EXPOSE 8000
ENTRYPOINT ["./docker-entrypoint.sh"]
