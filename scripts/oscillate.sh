#!/bin/bash

# Port number must be provided
if [ -z "$1" ]; then
    echo "Usage: $0 <port_number>"
    exit 1
fi

PORT=$1

# Function to get random duration between min and max
get_random_duration() {
    local min=$1
    local max=$2
    echo $((RANDOM % (max - min + 1) + min))
}

# Function to get PID from port
get_pid_from_port() {
    local pid=$(lsof -ti :$PORT)
    if [ -z "$pid" ]; then
        echo "No process found listening on port $PORT"
        exit 1
    fi
    echo $pid
}

while true; do
    PID=$(get_pid_from_port)
    echo "Found process PID: $PID on port $PORT"
    
    # Generate random durations between 2-70 seconds
    PAUSE_DURATION=$(get_random_duration 2 70)
    RESUME_DURATION=$(get_random_duration 2 70)
    
    echo "Pausing process for $PAUSE_DURATION seconds..."
    kill -STOP $PID
    sleep $PAUSE_DURATION
    
    echo "Resuming process for $RESUME_DURATION seconds..."
    kill -CONT $PID
    sleep $RESUME_DURATION
done 