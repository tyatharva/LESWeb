import os
import json
import torch
import colormaps
import rasterio
from rasterio.transform import from_bounds
from rasterio.warp import reproject, Resampling
from rasterio.crs import CRS

import matplotlib.cm as cm
import numpy as np
import xarray as xr
from PIL import Image
from matplotlib.cm import ScalarMappable
import matplotlib.colors as mcolors


def get_cmap(varname):
    """
    Return a colormap and norm for the given variable name.
    Returns (ScalarMappable, bounds) where bounds may be None.
    """
    # Precipitation and snow outputs
    if varname in ["QPE_hrrr", "QPE_past", "QPE_target", "LESNet-A", "LESNet-B"]:
        cmap_obj = colormaps.cm_snow()
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Radar reflectivity
    if varname == "SHSR_mrms":
        cmap_obj = colormaps.cm_reflectivity()
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Wind components in knots
    if varname in ["UGRD_850mb", "VGRD_850mb", "UGRD_925mb", "VGRD_925mb"]:
        # cmap_obj = colormaps.cm_wind()
        # return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
        bounds = np.linspace(-50, 50, 51)
        cmap = cm.get_cmap("Spectral")
        norm = mcolors.BoundaryNorm(bounds, cmap.N, extend="neither")
        return ScalarMappable(norm=norm, cmap=cmap), bounds
    # Dew point in Celsius (upper air)
    if varname in ["DPT_850mb", "DPT_925mb"]:
        cmap_obj = colormaps.cm_dpt(units="C")
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Temperature in Celsius (upper air)
    if varname in ["TMP_850mb", "TMP_925mb"]:
        cmap_obj = colormaps.cm_tmp(units="C")
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Dew point in Fahrenheit (surface/2m)
    if varname == "DPT_2m":
        cmap_obj = colormaps.cm_dpt(units="F")
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Temperature in Fahrenheit (surface/masked)
    if varname in ["TMP_surface", "TMP_masked"]:
        cmap_obj = colormaps.cm_tmp(units="F")
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Equivalent potential temperature in Kelvin
    if varname in ["THTE_masked", "THTE_850mb"]:
        cmap_obj = colormaps.cm_tmp(units="K")
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Convective available potential energy
    if varname == "CAPE_surface":
        cmap_obj = colormaps.cm_pcp()
        return ScalarMappable(norm=cmap_obj.norm, cmap=cmap_obj.cmap), getattr(cmap_obj, "bounds", None)
    # Binary fields
    if varname in ["landsea", "ICEC_surface"]:
        bounds = np.linspace(0, 1, 3)
        cmap = cm.get_cmap("seismic")
        norm = mcolors.BoundaryNorm(bounds, cmap.N, extend="neither")
        return ScalarMappable(norm=norm, cmap=cmap), bounds
    # Divergence and relative vorticity
    if varname in ["DIVG_925mb", "RELV_925mb"]:
        bounds = np.linspace(-50, 50, 51)
        cmap = cm.get_cmap("seismic")
        norm = mcolors.BoundaryNorm(bounds, cmap.N, extend="neither")
        return ScalarMappable(norm=norm, cmap=cmap), bounds
    # Surface flow
    if varname == "flow":
        bounds = np.linspace(-1, 1, 51)
        cmap = cm.get_cmap("seismic")
        norm = mcolors.BoundaryNorm(bounds, cmap.N, extend="neither")
        return ScalarMappable(norm=norm, cmap=cmap), bounds
    # Elevation: terrain colormap with custom bounds
    if varname == "elev":
        bounds = np.linspace(-750, 2000, 23)
        cmap = cm.get_cmap("terrain")
        norm = mcolors.BoundaryNorm(bounds, cmap.N, extend="neither")
        return ScalarMappable(norm=norm, cmap=cmap), bounds
    # Fallback to viridis
    return ScalarMappable(norm=mcolors.Normalize(), cmap=cm.get_cmap("viridis")), None


def preprocess_variables(varname, var):
    if varname in ["QPE_hrrr", "QPE_past", "QPE_target", "LESNet-A", "LESNet-B"]: var = np.where(var < 0.05, 0, var)
    if varname in ["UGRD_850mb", "VGRD_850mb", "UGRD_925mb", "VGRD_925mb", "flow"]: var = var * 1.94384  # m/s to knots
    if varname in ["DPT_850mb", "TMP_850mb", "DPT_925mb", "TMP_925mb"]: var = var - 273.15 # K to Celsius
    if varname in ["TMP_surface", "DPT_2m", "TMP_masked"]: var = (var - 273.15) * 9.0/5.0 + 32.0 # K to Fahrenheit
    if varname in ["DIVG_925mb", "RELV_925mb"]: var = var * 1e5
    if varname == "flow": var = np.where((var > -0.01) & (var < 0.01), 0, var)
    return var


def nc_to_tensor(nc, input_nc):
    vars = []
    if input_nc == 14:
        vars = ['QPE_past', 'SHSR_mrms', 'UGRD_850mb', 'VGRD_850mb', 'DPT_850mb', 'TMP_850mb', 'UGRD_925mb',
                'VGRD_925mb','DPT_925mb', 'TMP_925mb', 'TMP_surface', 'DPT_2m', 'elev', 'landsea']
    elif input_nc == 10:
        vars = ['QPE_past', 'SHSR_mrms', 'CAPE_surface', 'TMP_masked', 'TMP_850mb',
                'DPT_850mb', 'UGRD_850mb', 'VGRD_850mb', 'ICEC_surface', 'elev']
    elif input_nc == 9:
        vars = ['QPE_past', 'SHSR_mrms', 'THTE_masked', 'THTE_850mb', 'UGRD_850mb',
                'VGRD_850mb', 'DIVG_925mb', 'RELV_925mb', 'flow']
    elif input_nc == 7:
        vars = ['QPE_past', 'SHSR_mrms', 'TMP_surface', 'TMP_850mb', 'UGRD_850mb', 'VGRD_850mb', 'elev']
    elif input_nc == 2:
        vars = ['QPE_past', 'SHSR_mrms']

    ds = xr.open_dataset(nc)
    A = torch.stack([torch.from_numpy(ds[var][:, :].values) for var in vars], dim=0).float()
    A = torch.flip(A, dims=[1])
    return A


def process_netcdf_to_pngs(in_path, out_dir):
    # Ensure output directory exists
    os.makedirs(out_dir, exist_ok=True)
    ds = xr.open_dataset(in_path)
    # Try to get georeferencing info
    lats = ds.coords['lat'].values if 'lat' in ds.coords else None
    lons = ds.coords['lon'].values if 'lon' in ds.coords else None

    if lats is None or lons is None:
        raise ValueError("Dataset must have lat/lon coordinates")

    for var in ds.data_vars:
        # Get original data
        arr = ds[var].values.astype(np.float32)
        arr = np.flipud(arr)

        # Preprocess values BEFORE color mapping
        arr = preprocess_variables(var, arr.copy())
        arr = np.nan_to_num(arr)

        # Get color mapping
        mapper, bounds = get_cmap(var)
        if isinstance(mapper.norm, mcolors.Normalize) and mapper.norm.vmin is None and mapper.norm.vmax is None:
            mapper.norm.vmin = float(np.nanmin(arr))
            mapper.norm.vmax = float(np.nanmax(arr))

        # Create colored array
        rgba_img = mapper.to_rgba(arr, bytes=True)
        rgb_img = rgba_img[..., :3]  # Drop alpha channel

        # Calculate transform for the GeoTIFF (EPSG:4326 - lat/lon)
        height, width = arr.shape
        transform = from_bounds(
            west=float(lons[0]),
            south=float(lats[0]),
            east=float(lons[-1]),
            north=float(lats[-1]),
            width=width,
            height=height
        )

        # Save original GeoTIFF in EPSG:4326
        tiff_4326_path = os.path.join(out_dir, f"{var}_4326.tif")
        with rasterio.open(
            tiff_4326_path,
            'w',
            driver='GTiff',
            height=height,
            width=width,
            count=3,
            dtype=rgb_img.dtype,
            crs=CRS.from_epsg(4326),
            transform=transform,
        ) as dst:
            for i in range(3):
                dst.write(rgb_img[:, :, i], i + 1)

        # Reproject to Web Mercator (EPSG:3857)
        tiff_3857_path = os.path.join(out_dir, f"{var}.tif")
        with rasterio.open(tiff_4326_path) as src:
            # Calculate output dimensions
            dst_crs = CRS.from_epsg(3857)
            transform_3857, width_3857, height_3857 = rasterio.warp.calculate_default_transform(
                src.crs, dst_crs, width, height,
                left=float(lons[0]), bottom=float(lats[0]),
                right=float(lons[-1]), top=float(lats[-1])
            )

            out_profile = src.profile.copy()
            out_profile.update({
                'crs': dst_crs,
                'transform': transform_3857,
                'width': width_3857,
                'height': height_3857
            })

            with rasterio.open(tiff_3857_path, 'w', **out_profile) as dst:
                for i in range(1, 4):
                    reproject(
                        source=rasterio.band(src, i),
                        destination=rasterio.band(dst, i),
                        src_transform=src.transform,
                        src_crs=src.crs,
                        dst_transform=transform_3857,
                        dst_crs=dst_crs,
                        resampling=Resampling.nearest
                    )

        # Save metadata with values and georeferencing for value readout
        meta = {
            "variable": var,
            "shape": arr.shape,
            "dtype": str(arr.dtype),
            "georeferencing": {
                "lat": [float(lats[0]), float(lats[0]), float(lats[-1]), float(lats[-1])],
                "lon": [float(lons[0]), float(lons[-1]), float(lons[0]), float(lons[-1])]
            },
            "values": np.flipud(arr).tolist()  # Save preprocessed values
        }
        json_path = os.path.join(out_dir, f"{var}.json")
        with open(json_path, "w") as f:
            json.dump(meta, f, indent=2)

    ds.close()


def ds_to_nc(ds1, in_nc_path, out_nc_path, lake):
    ds1 = ds1.isel(y=slice(None, None, -1))
    ds2 = xr.open_dataset(in_nc_path)
    ds = xr.merge([ds1, ds2])
    ds1.close()
    ds2.close()
    # Metadata for the grid
    lat_min = 0.0 # Bottom-left latitude
    lon_min = 0.0 # Bottom-left longitude

    if (lake == "erie"):
        lat_min = 40.97
        lon_min = -82.62
    elif (lake == "michigan"):
        lat_min = 41.88
        lon_min = -87.03
    elif (lake == "ontario"):
        lat_min = 42.47
        lon_min = -79.12
    elif (lake == "superior"):
        lat_min = 45.97
        lon_min = -90.12

    lat_step = 0.01  # Step size in degrees for latitude
    lon_step = 0.01  # Step size in degrees for longitude

    # Dimensions of the grid
    height, width = 256, 512
    if (lake == "michigan"):
        height, width = 512, 256

    # Create 1D coordinate arrays
    lats = lat_min + np.arange(height) * lat_step
    lons = lon_min + np.arange(width) * lon_step
    ds = ds.rename({'y': 'lat', 'x': 'lon'})
    ds = ds.assign_coords(lat=lats, lon=lons)
    ds.to_netcdf(out_nc_path, format="NETCDF4")
