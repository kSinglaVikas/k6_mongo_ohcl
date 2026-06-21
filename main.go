package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
)

// Config holds MongoDB connection details.
var (
	mongoURI       string
	dbName         string
	findColl       string
	aggColl        string
	debugEnabled   bool
	maxPoolSize    uint64
	minPoolSize    uint64
	mongoClient    *mongo.Client
	db             *mongo.Database
)

// FindRequest represents a find query request.
type FindRequest struct {
	Collection string                 `json:"collection"`
	Filter     map[string]interface{} `json:"filter"`
	Projection map[string]interface{} `json:"projection"`
	Sort       map[string]interface{} `json:"sort"`
}

// AggregateRequest represents an aggregation pipeline request.
type AggregateRequest struct {
	Collection string                   `json:"collection"`
	Pipeline   []map[string]interface{} `json:"pipeline"`
}

// QueryResponse wraps the result with timing info.
type QueryResponse struct {
	DurationMs float64 `json:"duration_ms"`
	Count      int     `json:"count"`
	Error      string  `json:"error,omitempty"`
}

func init() {
	mongoURI = os.Getenv("MONGO_URI")
	if mongoURI == "" {
		mongoURI = "mongodb://localhost:27017"
	}
	dbName = os.Getenv("DB_NAME")
	if dbName == "" {
		dbName = "ohcl_data"
	}
	findColl = os.Getenv("ONED_EQ_COLLECTION")
	if findColl == "" {
		findColl = os.Getenv("FIND_COLLECTION")
	}
	if findColl == "" {
		findColl = "oned-eq"
	}
	aggColl = os.Getenv("HISTORIC_EQ_COLLECTION")
	if aggColl == "" {
		aggColl = os.Getenv("AGG_COLLECTION")
	}
	if aggColl == "" {
		aggColl = "historic-eq"
	}

	if v := os.Getenv("DEBUG"); v != "" {
		if enabled, err := strconv.ParseBool(v); err == nil {
			debugEnabled = enabled
		}
	}

	// Connection pool configuration
	maxPoolSize = 200 // default MongoDB driver max
	if v := os.Getenv("MAX_POOL_SIZE"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 32); err == nil {
			maxPoolSize = n
		}
	}

	minPoolSize = 100 // reasonable default for concurrent workloads
	if v := os.Getenv("MIN_POOL_SIZE"); v != "" {
		if n, err := strconv.ParseUint(v, 10, 32); err == nil {
			minPoolSize = n
		}
	}

	log.Printf("Connection pool config: min=%d, max=%d", minPoolSize, maxPoolSize)
	log.Printf("Debug logging enabled: %t", debugEnabled)
}

func debugLogf(format string, args ...interface{}) {
	if !debugEnabled {
		return
	}
	log.Printf("[debug] "+format, args...)
}

func compactJSON(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "<marshal_error>"
	}
	s := string(b)
	if len(s) > 400 {
		return s[:400] + "..."
	}
	return s
}

func isComparisonOperator(key string) bool {
	switch key {
	case "$gte", "$gt", "$lte", "$lt", "$eq":
		return true
	default:
		return false
	}
}

func parseRFC3339String(s string) (time.Time, bool) {
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t, true
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t, true
	}
	return time.Time{}, false
}

func normalizeQueryValue(v interface{}, parentKey string) interface{} {
	switch x := v.(type) {
	case map[string]interface{}:
		normalized := make(map[string]interface{}, len(x))
		for k, child := range x {
			normalized[k] = normalizeQueryValue(child, k)
		}
		return normalized
	case []interface{}:
		normalized := make([]interface{}, len(x))
		for i, item := range x {
			normalized[i] = normalizeQueryValue(item, parentKey)
		}
		return normalized
	case string:
		if isComparisonOperator(parentKey) {
			if t, ok := parseRFC3339String(x); ok {
				return t
			}
		}
		return x
	default:
		return v
	}
}

// connectMongo establishes the MongoDB connection with configured pooling.
func connectMongo() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	opts := options.Client().
		ApplyURI(mongoURI).
		SetMaxPoolSize(maxPoolSize).
		SetMinPoolSize(minPoolSize)

	client, err := mongo.Connect(ctx, opts)
	if err != nil {
		return err
	}

	if err := client.Ping(ctx, nil); err != nil {
		return err
	}

	mongoClient = client
	db = client.Database(dbName)
	log.Printf("Connected to MongoDB database %s (pool: %d-%d)", dbName, minPoolSize, maxPoolSize)
	return nil
}

// handleFind handles POST /find — executes a find query and measures latency.
func handleFind(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req FindRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}

	if req.Collection == "" {
		req.Collection = findColl
	}

	normalizedFilter := req.Filter
	if req.Filter != nil {
		if v, ok := normalizeQueryValue(req.Filter, "").(map[string]interface{}); ok {
			normalizedFilter = v
		}
	}

	debugLogf("find request filter=%s projection=%s sort=%s", compactJSON(normalizedFilter), compactJSON(req.Projection), compactJSON(req.Sort))

	coll := db.Collection(req.Collection)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	opts := options.Find().SetBatchSize(200)
	if req.Projection != nil {
		opts.SetProjection(req.Projection)
	}
	if req.Sort != nil {
		opts.SetSort(req.Sort)
	}

	t0 := time.Now()
	cursor, err := coll.Find(ctx, normalizedFilter, opts)
	elapsed := time.Since(t0).Seconds() * 1000.0
	if err != nil {
		debugLogf("find query failed error=%v", err)
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		debugLogf("find cursor read failed error=%v", err)
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}

	debugLogf("find response count=%d duration_ms=%.2f", len(results), elapsed)
	writeResponse(w, &QueryResponse{
		DurationMs: elapsed,
		Count:      len(results),
	})
}

// handleAggregate handles POST /aggregate — executes an aggregation pipeline.
func handleAggregate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req AggregateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}

	if req.Collection == "" {
		req.Collection = aggColl
	}

	debugLogf("aggregate request pipeline=%s", compactJSON(req.Pipeline))

	coll := db.Collection(req.Collection)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Convert pipeline to bson.A
	pipeline := make(bson.A, len(req.Pipeline))
	for i, stage := range req.Pipeline {
		if v, ok := normalizeQueryValue(stage, "").(map[string]interface{}); ok {
			pipeline[i] = bson.M(v)
		} else {
			pipeline[i] = bson.M(stage)
		}
	}

	debugLogf("aggregate normalized pipeline=%s", compactJSON(pipeline))

	t0 := time.Now()
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		debugLogf("aggregate query failed error=%v", err)
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		debugLogf("aggregate cursor read failed error=%v", err)
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}

	elapsed := time.Since(t0).Seconds() * 1000.0
	debugLogf("aggregate response count=%d duration_ms=%.2f", len(results), elapsed)
	writeResponse(w, &QueryResponse{
		DurationMs: elapsed,
		Count:      len(results),
	})
}

// handleHealth responds with a simple health check.
func handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
}

// writeResponse encodes a QueryResponse as JSON.
func writeResponse(w http.ResponseWriter, resp *QueryResponse) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(resp)
}

func main() {
	if err := connectMongo(); err != nil {
		log.Fatalf("Failed to connect to MongoDB: %v", err)
	}
	defer mongoClient.Disconnect(context.Background())

	http.HandleFunc("/health", handleHealth)
	http.HandleFunc("/find", handleFind)
	http.HandleFunc("/aggregate", handleAggregate)

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	srv := &http.Server{Addr: ":" + port, Handler: nil}

	errCh := make(chan error, 1)
	go func() {
		log.Printf("Starting HTTP server on :%s", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(sigCh)

	select {
	case sig := <-sigCh:
		log.Printf("Shutdown signal received: %s", sig)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			log.Printf("Graceful shutdown failed: %v", err)
		} else {
			log.Printf("HTTP server stopped gracefully")
		}
	case err := <-errCh:
		log.Fatalf("Server error: %v", err)
	}
}
