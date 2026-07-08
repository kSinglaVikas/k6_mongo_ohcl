# syntax=docker/dockerfile:1

FROM golang:1.21-alpine AS builder
WORKDIR /src

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/mongo_wrapper .

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app

COPY --from=builder /out/mongo_wrapper /app/mongo_wrapper

EXPOSE 9000
ENV PORT=9000

ENTRYPOINT ["/app/mongo_wrapper"]
