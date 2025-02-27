#!/bin/sh
git pull
mv .env .env.xxx
docker compose build
mv .env.xxx .env
docker compose down
docker compose up -d
