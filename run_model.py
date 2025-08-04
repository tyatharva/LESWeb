import os
import shutil
import torch
import xarray as xr
import requests
import logging
import time
from util import nc_to_tensor, ds_to_nc, process_netcdf_to_pngs
from datetime import datetime
from UNetFormer import UNetFormer

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# X86 service configuration - update with your x86 instance's private IP
X86_SERVICE_URL = "http://localhost:5001"  # CHANGE THIS to your x86 instance's private IP


def load_generator(model_path, input_nc, output_nc=1, device="cpu"):
    model = UNetFormer(
        input_channels=input_nc,
        decode_channels=64,
        dropout=False,
        backbone_name='swsl_resnet18',
        pretrained=False,
        window_size=8,
        num_classes=output_nc
    )
    model.load_state_dict(torch.load(model_path, map_location=device))
    model.to(device)
    model.eval()
    return model


def run_lesnet_inference(get_time, lake, device="cpu"):
    os.environ['REMAP_EXTRAPOLATE'] = 'off'
    get_time = datetime.fromisoformat(get_time.replace("Z", "+00:00"))
    fname = get_time.strftime('%Y%m%d_%H') + lake[0]

    # Check if date/lake combination is in the missing list
    try:
        with open("./splits/missing.txt", "r") as f: missing_dates = [line.strip() for line in f.readlines()]
        if fname in missing_dates: raise ValueError(f"The requested date ({fname}) has missing data for {lake} and cannot be processed.")
    except FileNotFoundError: pass

    try:
        netcdf_path = f"./data/{fname}/{fname}_in.nc"
        output_path = f"./data/{fname}/out.nc"
        remote_process_day(get_time, lake[0], fname)

        model_keys = [f"{lake.lower()}_A", f"{lake.lower()}_B"]
        input_nc_lookup = {
            'erie_A': 9,    'erie_B': 9,
            'michigan_A': 14, 'michigan_B': 14,
            'ontario_A': 14, 'ontario_B': 14,
            'superior_A': 14, 'superior_B': 14,
        }

        results = []

        for key in model_keys:
            if key not in input_nc_lookup:
                raise ValueError(f"No model config for key: {key}")

            input_nc = input_nc_lookup[key]
            model_path = os.path.join("models", f"{key}.pth")

            # Load and preprocess input
            input_tensor = nc_to_tensor(netcdf_path, input_nc)
            input_tensor = input_tensor.unsqueeze(0)  # Add batch dim

            # Load model
            model = load_generator(model_path, input_nc=input_nc, device=device)

            # Run model
            with torch.no_grad():
                output_tensor = model(input_tensor.to(device))[0, 0].cpu()  # Shape: [H, W]

            results.append(output_tensor)

        # Convert to xarray.Dataset for named access
        ds = xr.Dataset({
            'LESNet-A': (('y', 'x'), results[0].numpy()),
            'LESNet-B': (('y', 'x'), results[1].numpy())
        })

        ds_to_nc(ds, netcdf_path, output_path, lake)
        os.remove(netcdf_path)
        print(f"Inference complete for {fname}.")
        process_netcdf_to_pngs(output_path, f"./data/{fname}/")
        print(f"Rendering complete for {fname}.")

    except Exception as e:
        raise RuntimeError(f"Runtime error for {fname}: {str(e)}. Please wait 5 seconds, refresh the page, and try again.") from e
        shutil.rmtree(f"./data/original/{fname}/", ignore_errors=True)
        shutil.rmtree(f"./data/{fname}/", ignore_errors=True)


def remote_process_day(date, lake, fname=None):
    """Call the x86 service to process data instead of running locally

    Args:
        date: Datetime object for the data to process
        lake: Lake identifier (e.g., 'e', 'm', 'o', 's')
        fname: Optional directory name, will be generated if not provided

    Returns:
        dirname: Name of the directory where processed data is stored
    """
    if fname is None:
        fname = date.strftime('%Y%m%d_%H') + lake

    logger.info(f"Requesting data processing for {date.isoformat()} lake={lake}")

    # Prepare destination directory
    os.makedirs(f"./data/{fname}", exist_ok=True)

    # Call the process endpoint
    retries = 3
    retry_delay = 5  # seconds

    for attempt in range(retries):
        try:
            # Start the remote processing
            response = requests.post(
                f"{X86_SERVICE_URL}/process",
                json={'date': date.isoformat(), 'lake': lake},
                timeout=30  # Initial request timeout
            )

            if response.status_code != 200:
                error_msg = response.json().get('error', 'Unknown error')
                raise Exception(f"Remote processing failed: {error_msg}")

            result = response.json()
            logger.info(f"Processing request successful, downloading result for {fname}")

            # Download the processed file with streaming and progress tracking
            download_response = requests.get(
                f"{X86_SERVICE_URL}/download/{result['dirname']}",
                stream=True,
                timeout=300  # Longer timeout for download
            )

            if download_response.status_code != 200:
                raise Exception(f"Failed to download processed file: {download_response.status_code}")

            # Save the file
            file_path = f"./data/{fname}/{fname}_in.nc"
            with open(file_path, 'wb') as f:
                downloaded = 0
                chunk_size = 8192  # 8KB chunks
                start_time = time.time()

                for chunk in download_response.iter_content(chunk_size=chunk_size):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)

                        # Log progress for large files
                        if downloaded > 10 * 1024 * 1024 and downloaded % (50 * 1024 * 1024) < chunk_size:  # Every 50MB
                            elapsed = time.time() - start_time
                            speed = downloaded / (1024 * 1024 * elapsed) if elapsed > 0 else 0
                            logger.info(f"Downloaded {downloaded/(1024*1024):.1f} MB in {elapsed:.1f}s ({speed:.1f} MB/s)")

            logger.info(f"Successfully downloaded {file_path}")
            return fname

        except Exception as e:
            logger.error(f"Attempt {attempt+1}/{retries} failed: {str(e)}")
            if attempt < retries - 1:
                logger.info(f"Retrying in {retry_delay} seconds...")
                time.sleep(retry_delay)
                retry_delay *= 2  # Exponential backoff
            else:
                logger.error("All retry attempts failed")
                raise Exception(f"Failed to process data remotely after {retries} attempts: {str(e)}")
