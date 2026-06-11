package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strconv"
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
	findColl = os.Getenv("FIND_COLLECTION")
	if findColl == "" {
		findColl = "1d_stocks"
	}
	aggColl = os.Getenv("AGG_COLLECTION")
	if aggColl == "" {
		aggColl = "7d_stocks"
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
	log.Printf("Connected to MongoDB: %s / %s (pool: %d-%d)", mongoURI, dbName, minPoolSize, maxPoolSize)
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

	coll := db.Collection(req.Collection)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	t0 := time.Now()
	opts := options.Find()
	if req.Projection != nil {
		opts.SetProjection(req.Projection)
	}
	if req.Sort != nil {
		opts.SetSort(req.Sort)
	}

	cursor, err := coll.Find(ctx, req.Filter, opts)
	if err != nil {
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}

	elapsed := time.Since(t0).Seconds() * 1000.0
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

	coll := db.Collection(req.Collection)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Convert pipeline to bson.A
	pipeline := make(bson.A, len(req.Pipeline))
	for i, stage := range req.Pipeline {
		pipeline[i] = bson.M(stage)
	}

	t0 := time.Now()
	cursor, err := coll.Aggregate(ctx, pipeline)
	if err != nil {
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}
	defer cursor.Close(ctx)

	var results []bson.M
	if err := cursor.All(ctx, &results); err != nil {
		writeResponse(w, &QueryResponse{Error: err.Error()})
		return
	}

	elapsed := time.Since(t0).Seconds() * 1000.0
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

	log.Printf("Starting HTTP server on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatalf("Server error: %v", err)
	}
}
