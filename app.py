import os
import json
import shutil
import threading
import time
import pytz
import queue
from datetime import datetime
from flask import Flask, render_template, request, jsonify, send_from_directory
from flask_apscheduler import APScheduler
from run_model import run_lesnet_inference

app = Flask(__name__)
scheduler = APScheduler()

# Create a queue for model runs
model_queue = queue.Queue()
# Dictionary to track model run status
model_status = {}
# Lock for thread-safe access to model_status
status_lock = threading.Lock()
# Maximum number of concurrent model runs
MAX_CONCURRENT_RUNS = 1
# Counter for active runs
active_runs = 0
# Unique ID counter for model runs
next_run_id = 0

@app.route('/')
def index():
    """Render the main page."""
    lakes = [
        {"id": "", "name": "Select a lake"},
        {"id": "erie", "name": "Lake Erie"},
        {"id": "michigan", "name": "Lake Michigan"},
        {"id": "ontario", "name": "Lake Ontario"},
        {"id": "superior", "name": "Lake Superior"}
    ]
    return render_template('index.html', lakes=lakes)

def process_model_queue():
    """Worker thread that processes the model queue"""
    global active_runs
    print(f"Worker thread starting at {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    while True:
        run_id = None
        try:
            # Get next item from queue (blocking call)
            run_id, lake, date_str = model_queue.get()
            print(f"Processing run {run_id} for {lake} at {date_str}")

            # Mark as processing
            with status_lock:
                if run_id in model_status:
                    active_runs += 1
                    model_status[run_id]['status'] = 'processing'
                else:
                    # This shouldn't happen, but just in case
                    print(f"Warning: Run {run_id} not found in status dict")
                    model_status[run_id] = {
                        'status': 'processing',
                        'submitted_at': datetime.now().isoformat(),
                        'lake': lake,
                        'date': date_str,
                        'queue_position': 0,
                        'result': None
                    }
                    active_runs += 1

            try:
                # Format date string to ISO format required by the model
                date_obj = datetime.strptime(date_str, '%Y-%m-%d %H:00')
                iso_date = date_obj.strftime('%Y-%m-%dT%H:%M:00Z')

                # Generate the folder name for output
                fname = date_obj.strftime('%Y%m%d_%H') + lake[0]

                # Check for existing folder with the same name
                output_path = os.path.join(os.path.dirname(__file__), 'data', fname)
                if os.path.exists(output_path):
                    # Don't delete immediately - check how old it is
                    try:
                        creation_time = os.path.getctime(output_path)
                        age_minutes = (time.time() - creation_time) / 60

                        # Only remove if older than 30 minutes to avoid conflicts with active views
                        if age_minutes > 30:
                            print(f"Removing old output directory: {output_path} ({age_minutes:.1f} minutes old)")
                            try:
                                shutil.rmtree(output_path)
                            except Exception as e:
                                print(f"Error removing directory {output_path}: {e}")
                        else:
                            print(f"Found recent output directory: {output_path} ({age_minutes:.1f} minutes old)")
                            # Use a unique folder name instead
                            unique_id = int(time.time()) % 10000
                            fname = f"{fname}_{unique_id}"
                            output_path = os.path.join(os.path.dirname(__file__), 'data', fname)
                            print(f"Using alternative output path: {output_path}")
                    except Exception as e:
                        print(f"Error checking directory age {output_path}: {e}")

                # Run the model with timeout protection
                run_started = time.time()
                print(f"Starting model inference for {run_id}")

                run_lesnet_inference(
                    get_time=iso_date,
                    lake=lake,
                    device="cpu"
                )

                run_duration = time.time() - run_started
                print(f"Model inference completed for {run_id} in {run_duration:.2f} seconds")

                # Update status with success
                with status_lock:
                    if run_id in model_status:
                        model_status[run_id]['status'] = 'completed'
                        model_status[run_id]['result'] = {
                            'success': True,
                            'data_path': f"data/{fname}/",
                            'folder_name': fname
                        }
                    else:
                        print(f"Warning: Run {run_id} not found in status dict after completion")
            except ValueError as e:
                print(f"ValueError in model run {run_id}: {e}")
                with status_lock:
                    if run_id in model_status:
                        model_status[run_id]['status'] = 'error'
                        model_status[run_id]['result'] = {
                            'success': False,
                            'error': str(e)
                        }
            except Exception as e:
                error_msg = str(e)
                print(f"Exception in model run {run_id}: {error_msg}")

                with status_lock:
                    if run_id in model_status:
                        model_status[run_id]['status'] = 'error'
                        model_status[run_id]['result'] = {
                            'success': False,
                            'error': error_msg
                        }
            finally:
                # Always decrement the active runs counter
                with status_lock:
                    active_runs = max(0, active_runs - 1)  # Ensure it never goes negative

                # Mark task as done
                model_queue.task_done()

                # Clean up status after some time for completed/error runs to prevent memory leaks
                if run_id and model_status.get(run_id, {}).get('status') in ['completed', 'error']:
                    def cleanup_status(run_id_to_clean):
                        time.sleep(3600)  # Keep status for an hour
                        with status_lock:
                            if run_id_to_clean in model_status:
                                # Check if it's still in a terminal state before removing
                                if model_status[run_id_to_clean].get('status') in ['completed', 'error']:
                                    del model_status[run_id_to_clean]
                                    print(f"Cleaned up status for {run_id_to_clean}")
                                else:
                                    print(f"Skipped cleanup for {run_id_to_clean} - status changed")

                    cleanup_thread = threading.Thread(
                        target=cleanup_status,
                        args=(run_id,),
                        daemon=True
                    )
                    cleanup_thread.start()
        except Exception as e:
            print(f"Critical error in queue worker: {e}")
            # If we have a run_id, mark it as failed
            if run_id:
                with status_lock:
                    if run_id in model_status:
                        model_status[run_id]['status'] = 'error'
                        model_status[run_id]['result'] = {
                            'success': False,
                            'error': f"Internal server error: {str(e)}"
                        }
                        active_runs = max(0, active_runs - 1)
                model_queue.task_done()

            # Sleep briefly to avoid busy-waiting in case of persistent errors
            time.sleep(1)

@app.route('/run_model', methods=['POST'])
def run_model():
    """Queue a model run and return a run ID for status checking."""
    global next_run_id

    data = request.json or {}
    lake = data.get('lake', 'erie').lower()
    date_str = data.get('date', '')

    try:
        # Validate inputs
        if not lake or not date_str:
            return jsonify({
                "success": False,
                "error": "Missing required parameters"
            }), 400

        # Format date string to check format
        date_obj = datetime.strptime(date_str, '%Y-%m-%d %H:00')

        # Generate the folder name to check for missing data
        fname = date_obj.strftime('%Y%m%d_%H') + lake[0]

        # Check if date/lake combination is in the missing list
        try:
            with open("./splits/missing.txt", "r") as f:
                missing_dates = [line.strip() for line in f.readlines()]

            if fname in missing_dates:
                return jsonify({
                    "success": False,
                    "error": f"The requested date ({date_str} UTC) has missing data for {lake} and cannot be processed."
                }), 400
        except FileNotFoundError:
            # If missing.txt doesn't exist, continue without checking
            pass

        # Get a unique ID for this run
        with status_lock:
            run_id = f"run_{next_run_id}"
            next_run_id += 1

            # Initialize status entry
            position_in_queue = model_queue.qsize()
            model_status[run_id] = {
                'status': 'queued',
                'submitted_at': datetime.now().isoformat(),
                'lake': lake,
                'date': date_str,
                'queue_position': position_in_queue,
                'result': None
            }

        # Add to queue
        model_queue.put((run_id, lake, date_str))

        return jsonify({
            "success": True,
            "run_id": run_id,
            "status": "queued",
            "queue_position": position_in_queue,
            "active_runs": active_runs,
            "max_runs": MAX_CONCURRENT_RUNS
        })
    except ValueError as e:
        return jsonify({"success": False, "error": str(e)}), 400
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500

@app.route('/data/<path:filename>')
def serve_data(filename):
    """Serve data files from the data directory."""
    return send_from_directory('data', filename)

@app.route('/get_available_data')
def get_available_data():
    """Return a list of available model output folders."""
    try:
        data_dir = os.path.join(os.path.dirname(__file__), 'data')
        if not os.path.exists(data_dir):
            return jsonify({"folders": []})

        folders = [d for d in os.listdir(data_dir)
                  if os.path.isdir(os.path.join(data_dir, d))
                  and os.path.exists(os.path.join(data_dir, d, 'out.nc'))]

        # Format: YYYYMMDD_HHL (L = lake initial)
        result = []
        for folder in folders:
            try:
                if len(folder) == 12:  # Expected format length
                    date_part = folder[:10]
                    lake_initial = folder[10]

                    # Map lake initial to full name
                    lake_map = {'e': 'Erie', 'm': 'Michigan', 'o': 'Ontario', 's': 'Superior'}
                    lake_name = lake_map.get(lake_initial, 'Unknown')

                    # Parse date and ensure it's treated as UTC
                    date_obj = datetime.strptime(date_part, '%Y%m%d_%H')
                    formatted_date = date_obj.strftime('%Y-%m-%d %H:00')

                    # Get folder creation time (ctime)
                    folder_path = os.path.join(data_dir, folder)
                    ctime = os.stat(folder_path).st_ctime
                    result.append({
                        "folder": folder,
                        "date": formatted_date,
                        "lake": lake_name,
                        "ctime": ctime
                    })
            except Exception:
                # Skip folders that don't match the expected format
                continue

        # Sort by ctime descending (most recent first)
        result.sort(key=lambda x: x["ctime"], reverse=True)
        return jsonify({"folders": result})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/model_status/<run_id>', methods=['GET'])
def get_model_status(run_id):
    """Get the status of a model run by ID"""
    with status_lock:
        if run_id in model_status:
            status_data = model_status[run_id].copy()

            # If run is completed, include the result data
            if status_data['status'] == 'completed' or status_data['status'] == 'error':
                result = status_data.get('result', {})
                return jsonify({
                    "run_id": run_id,
                    "status": status_data['status'],
                    "result": result
                })
            else:
                # For queued or processing runs, include position and counts
                return jsonify({
                    "run_id": run_id,
                    "status": status_data['status'],
                    "queue_position": status_data.get('queue_position', 0),
                    "active_runs": active_runs,
                    "max_runs": MAX_CONCURRENT_RUNS
                })
        else:
            return jsonify({"error": "Run ID not found"}), 404

# CDO error handling removed - errors are now handled uniformly

@app.route('/get_data_metadata/<folder>')
def get_data_metadata(folder):
    """Get metadata about the variables in a data folder."""
    try:
        data_dir = os.path.join(os.path.dirname(__file__), 'data', folder)
        if not os.path.exists(data_dir):
            return jsonify({"error": "Folder not found"}), 404

        json_files = [f for f in os.listdir(data_dir) if f.endswith('.json')]

        metadata = {}
        for json_file in json_files:
            var_name = json_file.replace('.json', '')
            with open(os.path.join(data_dir, json_file), 'r') as f:
                json_data = json.load(f)
                # Extract just the key information
                metadata[var_name] = {
                    "variable": var_name,
                    "georeferencing": json_data.get("georeferencing", {}),
                    "values": json_data.get("values", [])
                }

        return jsonify(metadata)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/splits/<lake_id>_split.csv')
def serve_split_csv(lake_id):
    """Serve the split CSV file for a specific lake."""
    try:
        split_path = os.path.join(os.path.dirname(__file__), 'splits', f"{lake_id}_split.csv")
        if not os.path.exists(split_path):
            return "Split file not found", 404

        with open(split_path, 'r') as f:
            csv_content = f.read()

        return csv_content, 200, {'Content-Type': 'text/csv'}
    except Exception as e:
        return str(e), 500

@app.route('/colorbars/<path:filename>')
def serve_colorbars(filename):
    """Serve static colorbar images."""
    return send_from_directory(
        os.path.join(os.path.dirname(__file__), 'colorbars'),
        filename
    )

# CDO error handling removed - function deleted

def clean_data_directory():
    """Clear all contents from the data directory"""
    print(f"Cleaning data directory at {datetime.now(pytz.UTC).strftime('%Y-%m-%d %H:%M:%S')} UTC")
    data_dir = os.path.join(os.path.dirname(__file__), 'data')
    if os.path.exists(data_dir):
        for item in os.listdir(data_dir):
            item_path = os.path.join(data_dir, item)
            try:
                if os.path.isdir(item_path):
                    shutil.rmtree(item_path)
                else:
                    os.remove(item_path)
            except Exception as e:
                print(f"Error removing {item_path}: {e}")
    print("Data directory cleanup complete")

def scheduled_cleanup():
    """Function called by the scheduler to clean the data directory daily"""
    print(f"Executing scheduled cleanup at {datetime.now(pytz.UTC).strftime('%Y-%m-%d %H:%M:%S')} UTC")
    clean_data_directory()
    print("Daily cleanup complete - no restart needed")

# Initialize the scheduler
def init_scheduler():
    """Set up the scheduler with jobs"""
    scheduler.init_app(app)

    # Add job to clean data directory daily at 06:00 UTC
    scheduler.add_job(
        id='scheduled_cleanup',
        func=scheduled_cleanup,
        trigger='cron',
        hour=6,
        minute=0,
        timezone=pytz.UTC
    )

    scheduler.start()
    print("Scheduler started - Daily cleanup scheduled for 06:00 UTC")

# Start worker threads for the model queue
def start_workers():
    """Start worker threads to process the model queue"""
    print(f"Starting {MAX_CONCURRENT_RUNS} worker threads for model queue")
    workers = []

    for i in range(MAX_CONCURRENT_RUNS):
        worker = threading.Thread(
            target=process_model_queue,
            daemon=True,
            name=f"model-worker-{i}"
        )
        worker.start()
        workers.append(worker)
        print(f"Started model worker thread {i}")

    # Add a monitoring thread to ensure worker threads stay alive
    def monitor_workers():
        while True:
            time.sleep(60)  # Check every minute
            for i, worker in enumerate(workers):
                if not worker.is_alive():
                    print(f"Worker {i} died, restarting...")
                    new_worker = threading.Thread(
                        target=process_model_queue,
                        daemon=True,
                        name=f"model-worker-{i}-restarted"
                    )
                    new_worker.start()
                    workers[i] = new_worker

    monitor_thread = threading.Thread(
        target=monitor_workers,
        daemon=True,
        name="worker-monitor"
    )
    monitor_thread.start()
    print("Started worker monitoring thread")

# Function to clean up stale model status entries
def cleanup_stale_status():
    """Periodically clean up stale entries in the model_status dictionary"""
    while True:
        time.sleep(3600)  # Run every hour
        try:
            with status_lock:
                current_time = datetime.now()
                stale_ids = []

                for run_id, status in model_status.items():
                    try:
                        # Parse the submission time
                        submitted_at = datetime.fromisoformat(status.get('submitted_at', ''))
                        # If it's older than 24 hours and in a terminal state, mark for cleanup
                        age_hours = (current_time - submitted_at).total_seconds() / 3600
                        if age_hours > 24 and status.get('status') in ['completed', 'error']:
                            stale_ids.append(run_id)
                        elif age_hours > 72:  # If older than 3 days, clean up regardless of status
                            stale_ids.append(run_id)
                            print(f"Cleaning up very old run {run_id} (status: {status.get('status')})")
                    except Exception as e:
                        # If we can't parse the time, check if it's a terminal state
                        if status.get('status') in ['completed', 'error']:
                            stale_ids.append(run_id)
                            print(f"Cleaning up run with invalid time format: {run_id}")

                # Remove stale entries
                for run_id in stale_ids:
                    del model_status[run_id]

                if stale_ids:
                    print(f"Cleaned up {len(stale_ids)} stale model status entries")
        except Exception as e:
            print(f"Error in cleanup_stale_status: {e}")

# Start the cleanup thread
cleanup_thread = threading.Thread(
    target=cleanup_stale_status,
    daemon=True,
    name="status-cleanup"
)
cleanup_thread.start()

# Start a thread to periodically log active runs and queue size
def log_system_status():
    """Periodically log information about system status"""
    while True:
        time.sleep(300)  # Every 5 minutes
        try:
            with status_lock:
                queue_size = model_queue.qsize()
                active = active_runs
                total_statuses = len(model_status)
                print(f"System status: Active runs: {active}, Queue size: {queue_size}, Status entries: {total_statuses}")
        except Exception as e:
            print(f"Error in log_system_status: {e}")

status_logger = threading.Thread(
    target=log_system_status,
    daemon=True,
    name="status-logger"
)
status_logger.start()

# Initialize workers outside the main block so they start
# even when run by a WSGI server like gunicorn
init_scheduler()
start_workers()

if __name__ == '__main__':
    app.run(debug=True, host='0.0.0.0', port=5000)
