# syntax=docker/dockerfile:1
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ARG VERSION=dev
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X helium-sync/internal/server.Version=${VERSION}" -o /out/helium-sync ./cmd/helium-sync

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/helium-sync /helium-sync
ENV HELIUM_SYNC_DATA=/data HELIUM_SYNC_ADDR=:8080
VOLUME /data
EXPOSE 8080
USER nonroot:nonroot
ENTRYPOINT ["/helium-sync"]
CMD ["serve"]
