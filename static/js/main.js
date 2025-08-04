// Store lake calendar data
const calendarData = {
  erie: null,
  michigan: null,
  ontario: null,
  superior: null,
};

// Track the current flatpickr instance
let fp = null;
let fpInitialized = false;
let creditsVisible = false;
let activeModelRunId = null;
let modelStatusCheckInterval = null;

// Check if flatpickr is available in the global scope
if (typeof flatpickr === "undefined") {
  console.error(
    "Flatpickr library not found! Calendar functionality will not work.",
  );
}

document.addEventListener("DOMContentLoaded", () => {
  // Function to add/update colorbar overlay on a panel
  function updateColorbar(mapIndex, layerName) {
    // Panel background container
    const panelElem = document.querySelector(
      `.map-panel:nth-child(${mapIndex + 1})`,
    );
    if (!panelElem) return;
    // Remove old colorbar if present
    const old = panelElem.querySelector(".panel-colorbar");
    if (old) panelElem.removeChild(old);
    // Create overlay image
    const img = document.createElement("img");
    img.src = `/colorbars/${layerName}.png`;
    img.className = "panel-colorbar";
    // Position within panel
    img.style.position = "absolute";
    img.style.bottom = "0px";
    img.style.left = "50%";
    img.style.transform = "translateX(-50%)";
    img.style.width = "auto";
    img.style.height = "50px";
    img.style.pointerEvents = "none";
    panelElem.appendChild(img);
  }

  // Inject CSS for pixelated overlays and MAE display
  const style = document.createElement("style");
  style.innerHTML = `
    .pixelated-overlay {
      image-rendering: pixelated;
    }

    .mae-display {
      position: absolute;
      top: 10px;
      right: 10px;
      background-color: rgba(255, 255, 255, 0.8);
      padding: 5px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: bold;
      z-index: 1000;
      pointer-events: none;
      box-shadow: 0 2px 4px rgba(0,0,0,0.1);
    }
  `;
  document.head.appendChild(style);
  // Lake bounds for zooming
  const lakeBounds = {
    erie: [
      [41.0, -83.0],
      [43.0, -78.0],
    ],
    michigan: [
      [41.5, -88.0],
      [46.0, -85.0],
    ],
    ontario: [
      [42.5, -80.0],
      [44.5, -76.0],
    ],
    superior: [
      [46.0, -92.0],
      [49.0, -85.0],
    ],
  };

  // Current folder and data
  let currentFolder = null;
  let currentMetadata = null;
  let allValueData = {}; // Store variable values for display

  // Initialize maps
  const maps = [];
  const mapOverlays = [null, null, null, null];

  // Initialize maps
  for (let i = 1; i <= 4; i++) {
    const map = L.map(`map${i}`, {
      zoomControl: false, // Add zoom control separately
      attributionControl: i === 4, // Only show attribution on fourth map
    }).setView([45, -84], 6);

    // Add base tile layer
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    maps.push(map);

    // Add lat/lon readout to bottom right of panel 4
    if (i === 4) {
      // Lat/lon readout control for panel 4
      const LatLonControl = L.Control.extend({
        options: { position: "bottomright" },
        onAdd: function () {
          const container = L.DomUtil.create("div", "latlon-readout");
          container.style.background = "rgba(255,255,255,0.8)";
          container.style.padding = "6px 12px";
          container.style.borderRadius = "4px";
          container.style.fontSize = "14px";
          container.style.fontWeight = "bold";
          container.style.boxShadow = "0 2px 6px rgba(0,0,0,0.07)";
          container.id = "latlon-readout";
          container.innerText = "Lat, Lon";
          return container;
        },
      });
      // REMOVE: latLonControl for panel 4
    }

    // Add mouse position tracking
    maps[i - 1].on("mousemove", function (e) {
      // Show crosshairs on all maps
      for (let j = 0; j < maps.length; j++) {
        // Create or update crosshair on all maps
        let crosshair = document.getElementById(`crosshair-${j + 1}`);
        if (!crosshair) {
          crosshair = document.createElement("div");
          crosshair.id = `crosshair-${j + 1}`;
          crosshair.className =
            j === i - 1 ? "map-crosshair active" : "map-crosshair";
          document.getElementById(`map${j + 1}`).appendChild(crosshair);
        } else {
          crosshair.className =
            j === i - 1 ? "map-crosshair active" : "map-crosshair";
        }

        // Convert latlng to pixel coordinates on each map
        const point = maps[j].latLngToContainerPoint(e.latlng);
        crosshair.style.left = `${point.x}px`;
        crosshair.style.top = `${point.y}px`;
        crosshair.style.display = "block";
      }

      // Update value displays on all maps
      for (let j = 0; j < maps.length; j++) {
        updateValueDisplay(e.latlng, j);
      }

      // Update floating lat/lon label above crosshair on hovered panel
      let floatLabel = document.getElementById("latlon-float");
      if (!floatLabel) {
        floatLabel = document.createElement("div");
        floatLabel.id = "latlon-float";
        floatLabel.style.position = "absolute";
        floatLabel.style.pointerEvents = "none";
        floatLabel.style.fontSize = "10px";
        floatLabel.style.fontWeight = "bold";
        floatLabel.style.padding = "1px 4px";
        floatLabel.style.borderRadius = "2px";
        floatLabel.style.mixBlendMode = "normal";
        floatLabel.style.color = "#ff1493"; // hot pink
        floatLabel.style.zIndex = "2000";
        floatLabel.style.textAlign = "center";
        floatLabel.style.lineHeight = "1.1";
        document.body.appendChild(floatLabel);
      }
      const lat = e.latlng.lat.toFixed(2);
      const lon = e.latlng.lng.toFixed(2);
      // Right-align both numbers to the width of the widest string
      const latStr = lat.toString();
      const lonStr = lon.toString();
      const maxLen = Math.max(latStr.length, lonStr.length);
      // Pad both strings on the left so they are right-aligned
      const pad = (str) => str.padStart(maxLen, " ");
      floatLabel.innerHTML = `<div style="text-align:right;white-space:pre;">${pad(latStr)}<br>${pad(lonStr)}</div>`;
      // Position top-right of crosshair on hovered panel, offset so it doesn't overlap
      const mapDiv = e.target._container;
      const rect = mapDiv.getBoundingClientRect();
      const point = e.target.latLngToContainerPoint(e.latlng);
      floatLabel.style.left = `${rect.left + point.x + 12}px`;
      floatLabel.style.top = `${rect.top + point.y - 18}px`;
      floatLabel.style.display = "block";
    });

    maps[i - 1].on("mouseout", function () {
      // Hide crosshairs when mouse leaves
      for (let j = 0; j < maps.length; j++) {
        const crosshair = document.getElementById(`crosshair-${j + 1}`);
        if (crosshair) {
          crosshair.style.display = "none";
        }
        document.getElementById(`value-display${j + 1}`).textContent = "";
      }
      // Hide floating lat/lon label
      const floatLabel = document.getElementById("latlon-float");
      if (floatLabel) floatLabel.style.display = "none";
    });

    // Use crosshair as main cursor on hovered panel, remove hot pink crosshair
    map.on("mousemove", function (e) {
      if (i === 1) {
        map.getContainer().style.cursor = "none";
      } else {
        map.getContainer().style.cursor = "none";
      }
      // Only show the crosshair for the actual mouse panel, not the hot pink one
      for (let j = 0; j < maps.length; j++) {
        const crosshair = document.getElementById(`crosshair-${j + 1}`);
        if (crosshair) {
          if (j === i - 1) {
            crosshair.className = "map-crosshair active";
          } else {
            crosshair.className = "map-crosshair";
          }
        }
      }
    });

    maps[i - 1].on("mouseout", function () {
      // Hide crosshairs when mouse leaves
      for (let j = 0; j < maps.length; j++) {
        const crosshair = document.getElementById(`crosshair-${j + 1}`);
        if (crosshair) {
          crosshair.style.display = "none";
        }
        document.getElementById(`value-display${j + 1}`).textContent = "";
      }
    });
  }

  // Synchronize map movements
  for (let i = 0; i < maps.length; i++) {
    maps[i].on("move", function (e) {
      const center = maps[i].getCenter();
      const zoom = maps[i].getZoom();

      for (let j = 0; j < maps.length; j++) {
        if (i !== j) {
          maps[j].setView(center, zoom, { animate: false });
        }
      }
    });
  }

  // Initialize date picker field - initially disabled
  const dateInput = document.getElementById("date-input");
  dateInput.disabled = true;

  // Lake selection event handler
  document
    .getElementById("lake-select")
    .addEventListener("change", function (e) {
      const lake = e.target.value;

      // Clear and disable date input if no lake selected
      const dateInput = document.getElementById("date-input");

      // Always reset flatpickr first
      if (fp) {
        try {
          fp.destroy();
          fpInitialized = false;
        } catch (e) {
          console.error("Error destroying flatpickr on lake change:", e);
        }
        fp = null;
      }

      if (!lake) {
        dateInput.disabled = true;
        dateInput.placeholder = "Select lake first";
        return;
      }

      // Enable date input
      dateInput.disabled = false;
      dateInput.placeholder = "Loading calendar data...";

      // Wait a short time to ensure the DOM is ready and previous instances are cleaned up
      setTimeout(() => {
        // Load and initialize calendar with lake-specific data
        loadCalendarData(lake);
      }, 100);
    });

  // Setup form submission
  document
    .getElementById("model-form")
    .addEventListener("submit", handleModelSubmit);

  // Setup panel selectors
  for (let i = 1; i <= 4; i++) {
    document
      .getElementById(`panel${i}-select`)
      .addEventListener("change", function () {
        updateMapLayer(i - 1);
      });
  }

  // Setup opacity slider
  document
    .getElementById("opacity-slider")
    .addEventListener("input", updateLayerOpacity);

  // Credits button functionality
  document
    .getElementById("credits-button")
    .addEventListener("click", toggleCredits);

  // Close credits when clicking outside
  document.addEventListener("click", function (event) {
    const creditsPopup = document.getElementById("credits-popup");
    const creditsButton = document.getElementById("credits-button");

    if (
      creditsVisible &&
      !creditsPopup.contains(event.target) &&
      !creditsButton.contains(event.target)
    ) {
      hideCredits();
    }
  });
  // Initialize percentage display on load
  updateLayerOpacity();

  // Load initial available data
  loadAvailableData();

  /**
   * Load calendar data for a specific lake
   */
  function loadCalendarData(lake) {
    if (!lake) {
      console.error("No lake specified for calendar data");
      return;
    }

    // Use first letter of lake name for the file name
    const lakeKey = lake.charAt(0);

    console.log(
      `Loading calendar data for lake: ${lake} using key: ${lakeKey}`,
    );

    // Enable date input and update placeholder
    const dateInput = document.getElementById("date-input");
    if (dateInput) {
      dateInput.disabled = false;
      dateInput.placeholder = "Loading calendar data...";
    }

    if (calendarData[lake]) {
      // We already have the data, initialize calendar
      console.log(`Using cached calendar data for lake: ${lake}`);
      initializeCalendar(lake, calendarData[lake]);
      return;
    }

    // Date input already enabled in the function beginning

    fetch(`/splits/${lakeKey}_split.csv`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.text();
      })
      .then((csvText) => {
        const data = parseCSVData(csvText);
        calendarData[lake] = data;

        // Check if data was successfully parsed
        if (!data.train.length && !data.val.length && !data.test.length) {
          console.warn("No valid dates found in CSV for lake:", lake);
        }

        initializeCalendar(lake, data);

        const dateInput = document.getElementById("date-input");
        if (dateInput) {
          dateInput.placeholder = "Click to select date & time";
        }
      })
      .catch((error) => {
        console.error(`Error loading calendar data: ${error}`);
        // Initialize with empty data if fetch fails
        initializeCalendar(lake, { train: [], val: [], test: [] });

        if (dateInput) {
          dateInput.placeholder = "Error loading calendar data";
        }
      });
  }

  /**
   * Parse CSV data from text
   */
  function parseCSVData(csvText) {
    if (!csvText) {
      console.error("Empty CSV text provided to parseCSVData");
      return { train: [], val: [], test: [] };
    }

    console.log("Parsing CSV data");

    try {
      const lines = csvText.trim().split("\n");
      if (lines.length === 0) {
        console.error("No lines found in CSV data");
        return { train: [], val: [], test: [] };
      }

      const headers = lines[0].split(",");
      const result = {
        train: [],
        val: [],
        test: [],
      };

      console.log(`Found ${lines.length} lines in CSV with headers:`, headers);

      // Skip header row
      for (let i = 1; i < lines.length; i++) {
        const columns = lines[i].split(",");
        headers.forEach((header, index) => {
          const headerKey = header.trim();
          if (headerKey in result && columns[index] && columns[index].trim()) {
            const dateParts = columns[index].trim().split("/");
            if (dateParts.length === 3) {
              try {
                const month = parseInt(dateParts[0], 10);
                const day = parseInt(dateParts[1], 10);
                let year = parseInt(dateParts[2], 10);

                // Ensure 4-digit year
                if (year < 100) {
                  year += 2000;
                }

                // Validate date components
                if (
                  month < 1 ||
                  month > 12 ||
                  day < 1 ||
                  day > 31 ||
                  isNaN(year)
                ) {
                  console.warn(
                    `Invalid date at line ${i + 1}, column ${index + 1}: ${columns[index].trim()}`,
                  );
                  return;
                }

                const dateStr = `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
                result[headerKey].push(dateStr);
              } catch (e) {
                console.error(
                  `Error parsing date at line ${i + 1}, column ${index + 1}:`,
                  e,
                );
              }
            } else {
              console.warn(
                `Invalid date format at line ${i + 1}, column ${index + 1}: ${columns[index].trim()}`,
              );
            }
          }
        });
      }

      console.log("Parsed CSV data:", result);
      return result;
    } catch (e) {
      console.error("Error parsing CSV data:", e);
      return { train: [], val: [], test: [] };
    }
  }

  /**
   * Initialize calendar with lake-specific data
   */
  function initializeCalendar(lake, data) {
    console.log("Initializing calendar for lake:", lake, "with data:", data);

    const dateInput = document.getElementById("date-input");
    if (!dateInput) {
      console.error("Date input element not found");
      return;
    }

    // Make sure flatpickr is available
    if (typeof flatpickr !== "function") {
      console.error(
        "flatpickr is not defined. Check if the library is properly loaded.",
      );
      dateInput.placeholder = "Calendar unavailable";
      return;
    }

    // Destroy existing instance if it exists
    if (fp) {
      try {
        fp.destroy();
        fpInitialized = false;
      } catch (e) {
        console.error("Error destroying flatpickr:", e);
      }
      fp = null;
    }

    // Reset any attached event listeners by cloning and replacing the element
    const newDateInput = dateInput.cloneNode(true);
    dateInput.parentNode.replaceChild(newDateInput, dateInput);
    // Update our reference to the input
    const updatedInput = document.getElementById("date-input");
    updatedInput.disabled = false;

    // Clear any existing value
    document.getElementById("date-input").value = "";

    // Configure date picker options
    const fpOptions = {
      enableTime: true,
      dateFormat: "Y-m-d H:00",
      defaultDate: "2024-11-30 23:00",
      time_24hr: true,
      allowInput: true,
      clickOpens: true,
      static: false,
      minuteIncrement: 60,
      minTime: "00:00",
      maxTime: "23:00",
      disableMobile: true,
      // Add legend on ready
      onReady: function (selectedDates, dateStr, instance) {
        addCalendarLegend(instance);
        highlightDates(instance, data);
      },
      // Shade days as they are created
      onDayCreate: function (selectedDates, dateStr, instance, dayElem) {
        const date = dayElem.dateObj;
        const formatted =
          `${date.getFullYear()}-` +
          `${String(date.getMonth() + 1).padStart(2, "0")}-` +
          `${String(date.getDate()).padStart(2, "0")}`;
        if (data.train.includes(formatted)) {
          dayElem.classList.add("train-date");
        } else if (data.val.includes(formatted)) {
          dayElem.classList.add("val-date");
        } else if (data.test.includes(formatted)) {
          dayElem.classList.add("test-date");
        }
      },
      // Update field when a day is picked
      onChange: function (selectedDates, dateStr, instance) {
        instance.input.value = dateStr;
      },
      // Update field and re-shade when hour input changes
      onValueUpdate: function (selectedDates, dateStr, instance) {
        if (selectedDates[0]) {
          const d = selectedDates[0];
          const formatted =
            `${d.getFullYear()}-` +
            `${String(d.getMonth() + 1).padStart(2, "0")}-` +
            `${String(d.getDate()).padStart(2, "0")} ` +
            `${String(d.getHours()).padStart(2, "0")}:00`;
          instance.input.value = formatted;
          highlightDates(instance, data);
        }
      },
      // Reapply shading when view changes or calendar closes
      onMonthChange: function () {
        addCalendarLegend(fp);
        highlightDates(fp, data);
      },
      onYearChange: function () {
        addCalendarLegend(fp);
        highlightDates(fp, data);
      },
      onClose: function () {
        highlightDates(fp, data);
      },
    };

    // Create new flatpickr instance
    try {
      // Get fresh reference to input element
      const dateInputElement = document.getElementById("date-input");
      // Create a clean flatpickr instance
      fp = flatpickr(dateInputElement, fpOptions);
      // Manual input change: reapply shading when user types a date
      dateInputElement.addEventListener("change", () => {
        if (fp) {
          highlightDates(fp, data);
        }
      });
      fpInitialized = true;

      console.log("Flatpickr successfully initialized:", fp !== null);

      // Create direct click handler that manually opens the calendar
      // Make sure the input field can receive focus and is interactive
      const dateInputEl = document.getElementById("date-input");
      dateInputEl.setAttribute("autocomplete", "off");
      dateInputEl.classList.add("flatpickr-input");

      // Allow clicking to open calendar but also support direct typing
      dateInputEl.addEventListener("click", function (e) {
        if (!this.disabled && fp && typeof fp.open === "function") {
          fp.open();
          e.stopPropagation();
        }
      });
    } catch (error) {
      console.error("Error initializing flatpickr:", error);
      fp = null;
      fpInitialized = false;
      document.getElementById("date-input").placeholder =
        "Calendar error - try another lake";
    }
  }

  /**
   * Add legend to calendar
   */
  function addCalendarLegend(instance) {
    // Remove existing legend
    const existingLegend =
      instance.calendarContainer.querySelector(".calendar-legend");
    if (existingLegend) {
      existingLegend.remove();
    }

    // Create legend container
    const legend = document.createElement("div");
    legend.className = "calendar-legend";

    // Legend items
    const items = [
      { name: "Train", className: "train-color" },
      { name: "Validation", className: "val-color" },
      { name: "Test", className: "test-color" },
    ];

    items.forEach((item) => {
      const legendItem = document.createElement("div");
      legendItem.className = "legend-item";

      const colorBox = document.createElement("div");
      colorBox.className = `legend-color ${item.className}`;

      const label = document.createElement("span");
      label.textContent = item.name;

      legendItem.appendChild(colorBox);
      legendItem.appendChild(label);
      legend.appendChild(legendItem);
    });

    // Append legend to calendar
    instance.calendarContainer.appendChild(legend);
  }

  /**
   * Highlight dates in calendar based on train/val/test data
   */
  function highlightDates(instance, data) {
    if (!instance || !instance.calendarContainer) {
      console.error("Invalid flatpickr instance in highlightDates");
      return;
    }

    // Ensure we have valid data arrays
    const trainDates = data && data.train ? data.train : [];
    const valDates = data && data.val ? data.val : [];
    const testDates = data && data.test ? data.test : [];

    // Get all day elements in the calendar
    const days = instance.calendarContainer.querySelectorAll(".flatpickr-day");
    if (!days || days.length === 0) {
      console.log("No day elements found in calendar");
      return;
    }

    days.forEach((dayElement) => {
      // Remove existing classes
      dayElement.classList.remove("train-date", "val-date", "test-date");

      if (!dayElement.classList.contains("flatpickr-disabled")) {
        const dateStr = dayElement.getAttribute("aria-label");
        if (dateStr) {
          try {
            const date = new Date(dateStr);

            // Check if date is valid
            if (isNaN(date.getTime())) {
              return;
            }

            const formattedDate = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")}`;

            // Add appropriate class based on which dataset contains this date
            if (trainDates.includes(formattedDate)) {
              dayElement.classList.add("train-date");
            } else if (valDates.includes(formattedDate)) {
              dayElement.classList.add("val-date");
            } else if (testDates.includes(formattedDate)) {
              dayElement.classList.add("test-date");
            }
          } catch (e) {
            // Silently skip invalid dates
          }
        }
      }
    });
  }

  /**
   * Get units for a variable
   */
  function getVariableUnits(variableName) {
    const unitMap = {
      QPE_hrrr: "mm",
      QPE_past: "mm",
      SHSR_mrms: "dBZ",
      UGRD_850mb: "kn",
      VGRD_850mb: "kn",
      DPT_850mb: "°C",
      TMP_850mb: "°C",
      UGRD_925mb: "kn",
      VGRD_925mb: "kn",
      DPT_925mb: "°C",
      TMP_925mb: "°C",
      TMP_surface: "°F",
      DPT_2m: "°F",
      elev: "m",
      landsea: "",
      CAPE_surface: "J/kg",
      TMP_masked: "°F",
      ICEC_surface: "",
      THTE_masked: "K",
      THTE_850mb: "K",
      DIVG_925mb: "1e-5/s",
      RELV_925mb: "1e-5/s",
      flow: "kn",
      QPE_target: "mm",
      "LESNet-A": "mm",
      "LESNet-B": "mm",
    };

    return unitMap[variableName] || "";
  }

  /**
   * Update value display based on mouse position
   */
  function updateValueDisplay(latlng, mapIndex) {
    const displayElement = document.getElementById(
      `value-display${mapIndex + 1}`,
    );
    const selectElement = document.getElementById(
      `panel${mapIndex + 1}-select`,
    );

    if (!currentMetadata || !selectElement || !selectElement.value) {
      displayElement.textContent = "";
      return;
    }

    const layerName = selectElement.value;
    const layer = currentMetadata[layerName];

    if (!layer || !layer.georeferencing || !allValueData[layerName]) {
      displayElement.textContent = "";
      return;
    }

    // Get bounding coordinates
    const lats = layer.georeferencing.lat;
    const lons = layer.georeferencing.lon;

    if (!lats || !lons) {
      displayElement.textContent = "";
      return;
    }

    // Calculate grid indices
    const height = allValueData[layerName].length;
    const width = allValueData[layerName][0].length;

    const latRange = lats[3] - lats[0];
    const lonRange = lons[1] - lons[0];

    const latNorm = (latlng.lat - lats[0]) / latRange;
    const lonNorm = (latlng.lng - lons[0]) / lonRange;

    if (latNorm < 0 || latNorm > 1 || lonNorm < 0 || lonNorm > 1) {
      displayElement.textContent = "";
      return;
    }

    // Convert to grid indices
    const rowIndex = Math.min(Math.floor(latNorm * height), height - 1);
    const colIndex = Math.min(Math.floor(lonNorm * width), width - 1);

    // Get and format the value
    try {
      const value = allValueData[layerName][rowIndex][colIndex];
      const formattedValue =
        typeof value === "number"
          ? value === 0
            ? "0.00"
            : Math.abs(value) < 0.01
              ? value.toExponential(2)
              : value.toFixed(2)
          : "N/A";

      // Get units for the variable
      const units = getVariableUnits(layerName);

      // Format the display text with units but without variable name
      displayElement.textContent = units
        ? `${formattedValue} ${units}`
        : formattedValue;
    } catch (e) {
      displayElement.textContent = "";
    }
  }

  /**
   * Show a notification that the model run was added to queue
   */
  function showQueueNotification() {
    const notification = document.createElement("div");
    notification.className = "queue-notification";
    notification.innerHTML = `
      <div class="queue-notification-content">
        <p>Model run added to queue!</p>
        <p>Only 1 model run can execute at a time.</p>
        <p>Your request will be processed automatically.</p>
        <p class="small">Please don't refresh the page.</p>
      </div>
    `;
    document.body.appendChild(notification);

    // Animate in
    setTimeout(() => {
      notification.classList.add("show");
    }, 10);

    // Remove after 4 seconds
    setTimeout(() => {
      notification.classList.remove("show");
      setTimeout(() => {
        document.body.removeChild(notification);
      }, 500);
    }, 4000);
  }

  /**
   * Load available datasets
   */
  /**
   * Check the status of a model run
   * @param {string} runId - The ID of the model run to check
   */
  function checkModelStatus(runId) {
    if (!runId) return;

    fetch(`/model_status/${runId}`)
      .then((response) => {
        if (!response.ok) {
          throw new Error("Status check failed");
        }
        return response.json();
      })
      .then((data) => {
        // If this isn't the active run anymore, stop checking
        if (runId !== activeModelRunId) {
          return;
        }

        const loadingIndicator = document.getElementById("loading-indicator");
        const queueStatus = document.getElementById("queue-status");
        const queuePosition = document.getElementById("queue-position");
        const runButton = document.getElementById("run-button");
        const errorMessage = document.getElementById("error-message");
        const progressContainer = document.getElementById("progress-container");
        const progressStatus = document.getElementById("progress-status");

        // Reset consecutive failures counter on successful response
        window.statusCheckFailures = 0;

        if (data.status === "queued") {
          // Still in queue
          loadingIndicator.classList.remove("hidden");
          loadingIndicator.querySelector("p").textContent =
            "Waiting in queue... Please wait.";
          queueStatus.classList.remove("hidden");
          queuePosition.textContent = data.queue_position + 1;
          runButton.disabled = true;
          errorMessage.classList.add("hidden");

          // Update progress
          progressContainer.classList.remove("hidden");
          progressStatus.textContent = "Waiting in queue...";
        } else if (data.status === "processing") {
          // Processing
          loadingIndicator.classList.remove("hidden");
          loadingIndicator.querySelector("p").textContent =
            "Running model... This may take a few minutes.";
          queueStatus.classList.add("hidden");
          runButton.disabled = true;
          errorMessage.classList.add("hidden");

          // Update progress
          progressContainer.classList.remove("hidden");
          progressStatus.textContent = "Processing model inference...";
        } else if (data.status === "completed") {
          // Completed successfully
          clearInterval(modelStatusCheckInterval);
          modelStatusCheckInterval = null;
          activeModelRunId = null;

          loadingIndicator.classList.add("hidden");
          queueStatus.classList.add("hidden");
          progressContainer.classList.add("hidden");
          runButton.disabled = false;
          errorMessage.classList.add("hidden");

          // Process the results as before
          loadAvailableData();
          setTimeout(() => {
            loadDataset(data.result.folder_name);
          }, 1000);
        } else if (data.status === "error") {
          // Error occurred
          clearInterval(modelStatusCheckInterval);
          modelStatusCheckInterval = null;
          activeModelRunId = null;

          loadingIndicator.classList.add("hidden");
          queueStatus.classList.add("hidden");
          progressContainer.classList.add("hidden");
          runButton.disabled = false;

          // Show appropriate error
          if (data.result && data.result.error) {
            if (data.result.error.includes("missing data")) {
              showError("Data Issue: " + data.result.error, true);
            } else {
              showError(
                "Model Error: " +
                  (data.result.error || "An unknown error occurred"),
              );
            }
          } else {
            showError("An error occurred while running the model");
          }
        } else {
          // Unknown status
          console.warn("Unknown model status:", data.status);
        }
      })
      .catch((error) => {
        console.error("Error checking model status:", error);

        // Count consecutive failures
        if (!window.statusCheckFailures) {
          window.statusCheckFailures = 1;
        } else {
          window.statusCheckFailures++;
        }

        // If too many consecutive failures, stop checking and show error
        if (window.statusCheckFailures > 3) {
          clearInterval(modelStatusCheckInterval);
          modelStatusCheckInterval = null;
          activeModelRunId = null;

          document.getElementById("loading-indicator").classList.add("hidden");
          document.getElementById("queue-status").classList.add("hidden");
          document.getElementById("progress-container").classList.add("hidden");
          document.getElementById("run-button").disabled = false;

          showError(
            "Connection Error: The server is not responding. Your request may still be processing. Please wait a moment and try again later.",
          );
          window.statusCheckFailures = 0;
        }
      });
  }

  function loadAvailableData() {
    const dataList = document.getElementById("data-list");
    dataList.innerHTML = "<p>Loading available datasets...</p>";

    fetch("/get_available_data")
      .then((response) => response.json())
      .then((data) => {
        if (data.folders && data.folders.length > 0) {
          dataList.innerHTML = "";

          // Sort by ctime descending (most recent first)
          data.folders
            .slice()
            .sort((a, b) => b.ctime - a.ctime)
            .forEach((folder) => {
              const item = document.createElement("div");
              item.className = "data-item";

              // Get proper lake name
              const lakeInitial = folder.folder[folder.folder.length - 1];
              const lakeMap = {
                e: "Erie",
                m: "Michigan",
                o: "Ontario",
                s: "Superior",
              };
              const lakeName = lakeMap[lakeInitial] || folder.lake;

              // Format the date from the folder name (which is already UTC)
              const folderTime = folder.folder.substring(0, 11);
              const formattedDate = `${folderTime.substring(0, 4)}-${folderTime.substring(4, 6)}-${folderTime.substring(6, 8)} ${folderTime.substring(9, 11)}:00`;

              item.innerHTML = `
              <h3>${formattedDate} UTC</h3>
              <p>${lakeName}</p>
            `;

              item.setAttribute("data-folder", folder.folder);
              item.addEventListener("click", () => loadDataset(folder.folder));
              dataList.appendChild(item);
            });
        } else {
          dataList.innerHTML =
            "<p>No data available. Run the model to generate data.</p>";
        }
      })
      .catch((error) => {
        console.error("Error loading data:", error);
        dataList.innerHTML = "<p>Error loading available datasets.</p>";
      });
  }

  /**
   * Handle model form submission
   */
  function handleModelSubmit(event) {
    event.preventDefault();

    const lake = document.getElementById("lake-select").value;
    const date = document.getElementById("date-input").value;

    if (!lake || !date) {
      showError("Please fill in all required fields");
      return;
    }

    // Clear any existing interval
    if (modelStatusCheckInterval) {
      clearInterval(modelStatusCheckInterval);
      modelStatusCheckInterval = null;
    }

    // Initialize UI for model submission
    document.getElementById("loading-indicator").classList.remove("hidden");
    document
      .getElementById("loading-indicator")
      .querySelector("p").textContent = "Submitting model run...";
    document.getElementById("error-message").classList.add("hidden");
    document.getElementById("run-button").disabled = true;
    document.getElementById("queue-status").classList.add("hidden");

    // Initialize progress
    const progressContainer = document.getElementById("progress-container");
    const progressStatus = document.getElementById("progress-status");
    progressContainer.classList.remove("hidden");
    progressStatus.textContent = "Submitting";

    // Submit the model run request
    submitModelRun(lake, date);
  }

  function submitModelRun(lake, date) {
    // Reset status check failures counter
    window.statusCheckFailures = 0;

    // Show notification that request is being submitted
    document.getElementById("loading-indicator").classList.remove("hidden");
    document
      .getElementById("loading-indicator")
      .querySelector("p").textContent = "Connecting to server...";

    // Call API to queue model run
    fetch("/run_model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lake, date }),
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Server error: ${response.status}`);
        }
        return response.json();
      })
      .then((data) => {
        if (data.success) {
          // Store the run ID for status checking
          activeModelRunId = data.run_id;

          // Update UI based on status
          const loadingIndicator = document.getElementById("loading-indicator");
          const queueStatus = document.getElementById("queue-status");

          if (data.status === "queued") {
            // Show queue info
            loadingIndicator.querySelector("p").textContent =
              "Waiting in queue... Please wait.";
            queueStatus.classList.remove("hidden");
            document.getElementById("queue-position").textContent =
              data.queue_position + 1;

            // Update progress
            document.getElementById("progress-status").textContent = "Queued";

            // Show notification about being in queue
            if (data.queue_position > 0) {
              showQueueNotification();
            }
          } else {
            // Likely processing immediately
            loadingIndicator.querySelector("p").textContent =
              "Running model... This may take a few minutes.";
            queueStatus.classList.add("hidden");

            // Update progress
            document.getElementById("progress-status").textContent =
              "Processing";
          }

          // Start checking status with a slightly longer interval
          modelStatusCheckInterval = setInterval(() => {
            checkModelStatus(activeModelRunId);
          }, 3000);

          // Also check immediately
          checkModelStatus(activeModelRunId);
        } else {
          // Handle immediate error
          document.getElementById("loading-indicator").classList.add("hidden");
          document.getElementById("progress-container").classList.add("hidden");
          document.getElementById("run-button").disabled = false;

          showError(
            "Server Error: " + (data.error || "Failed to submit model run"),
          );
        }
      })
      .catch((error) => {
        console.error("Error:", error);
        document.getElementById("loading-indicator").classList.add("hidden");
        document.getElementById("progress-container").classList.add("hidden");
        document.getElementById("run-button").disabled = false;
        showError(
          "Connection Error: Could not reach the server. Please check your internet connection and try again in a few moments.",
        );
      });
  }

  /**
   * Load a specific dataset
   */
  function loadDataset(folder) {
    currentFolder = folder;
    allValueData = {}; // Reset stored values

    // Highlight selected item
    const dataItems = document.querySelectorAll(".data-item");
    dataItems.forEach((item) => {
      item.classList.remove("active");
      if (item.getAttribute("data-folder") === folder) {
        item.classList.add("active");
      }
    });

    // Get metadata for the folder
    fetch(`/get_data_metadata/${folder}`)
      .then((response) => response.json())
      .then((metadata) => {
        currentMetadata = metadata;

        // Show layer controls
        document.getElementById("layer-control").classList.remove("hidden");

        // Determine lake from folder name
        const lakeInitial = folder[folder.length - 1];
        const lakeMap = {
          e: "erie",
          m: "michigan",
          o: "ontario",
          s: "superior",
        };
        const lake = lakeMap[lakeInitial] || "erie";

        // Zoom to lake bounds
        if (lakeBounds[lake]) {
          maps[0].fitBounds(lakeBounds[lake]);
        }

        // Prepare variables for panel selectors
        const lesnetLayers = ["LESNet-A", "LESNet-B"];
        const otherLayers = Object.keys(metadata).filter(
          (layer) => !lesnetLayers.includes(layer),
        );

        // Populate panel selectors
        for (let i = 1; i <= 4; i++) {
          const panelSelect = document.getElementById(`panel${i}-select`);
          panelSelect.innerHTML = "";

          // Add LESNet layers first
          lesnetLayers.forEach((layer) => {
            if (metadata[layer]) {
              const option = document.createElement("option");
              option.value = layer;
              option.textContent = layer;
              panelSelect.appendChild(option);
            }
          });

          // Add separator
          if (
            lesnetLayers.some((layer) => metadata[layer]) &&
            otherLayers.length > 0
          ) {
            const separator = document.createElement("option");
            separator.disabled = true;
            separator.textContent = "──────────────";
            panelSelect.appendChild(separator);
          }

          // Add other variables
          otherLayers.forEach((layer) => {
            const option = document.createElement("option");
            option.value = layer;
            option.textContent = layer;
            panelSelect.appendChild(option);
          });

          // Set default selections based on panel number
          if (panelSelect.options.length > 0) {
            // Panel 3 default
            if (
              i === 3 &&
              panelSelect.querySelector('option[value="QPE_hrrr"]')
            ) {
              panelSelect.value = "QPE_hrrr";
            }
            // Panel 4 default
            else if (
              i === 4 &&
              panelSelect.querySelector('option[value="QPE_target"]')
            ) {
              panelSelect.value = "QPE_target";
            }
            // First two panels use LESNet layers
            else if (i <= 2 && lesnetLayers[i - 1] in metadata) {
              panelSelect.value = lesnetLayers[i - 1];
            }
            // Fallback for other panels
            else if (otherLayers.length > 0) {
              const index = (i - 3) % otherLayers.length;
              panelSelect.value = otherLayers[index];
            } else {
              panelSelect.value = panelSelect.options[0].value;
            }
          }
        }

        // Update all map layers (which will also load JSON data)

        // Update all map layers
        for (let i = 0; i < 4; i++) {
          updateMapLayer(i);
        }
      })
      .catch((error) => {
        console.error("Error loading metadata:", error);
        showError("Failed to load dataset metadata");
      });
  }

  /**
   * Update a specific map layer
   */
  function updateMapLayer(mapIndex) {
    if (!currentFolder || !currentMetadata) return;

    const panelSelect = document.getElementById(`panel${mapIndex + 1}-select`);
    if (!panelSelect) return;

    const layerName = panelSelect.value;
    const opacity = parseFloat(document.getElementById("opacity-slider").value);

    // Remove existing overlay
    if (mapOverlays[mapIndex]) {
      maps[mapIndex].removeLayer(mapOverlays[mapIndex]);
      mapOverlays[mapIndex] = null;
    }

    if (!layerName) return;

    // Add new GeoTIFF overlay and JSON data for value readout
    const tiffUrl = `/data/${currentFolder}/${layerName}.tif`;
    const jsonUrl = `/data/${currentFolder}/${layerName}.json`;

    // Load both GeoTIFF and JSON data
    Promise.all([
      fetch(tiffUrl).then((response) => response.arrayBuffer()),
      fetch(jsonUrl).then((response) => response.json()),
    ])
      .then(([arrayBuffer, jsonData]) => {
        // Store the values data for readout
        if (jsonData.values) {
          allValueData[layerName] = jsonData.values;
          currentMetadata[layerName] = jsonData;
        }

        // Create and add the GeoTIFF layer
        return parseGeoraster(arrayBuffer).then((georaster) => {
          mapOverlays[mapIndex] = new GeoRasterLayer({
            georaster: georaster,
            opacity: opacity,
            resolution: 256,
          }).addTo(maps[mapIndex]);

          // Update panel header
          const panelHeader = document.querySelector(
            `.map-panel:nth-child(${mapIndex + 1}) .panel-header`,
          );
          if (panelHeader) {
            panelHeader.textContent = layerName;
          }

          // Overlay static colorbar in this panel
          updateColorbar(mapIndex, layerName);

          // Calculate and display MAE
          calculateMAE(mapIndex, layerName);
          // Also update the colorbar for this panel
          updateColorbar(mapIndex, layerName);
        });
      })
      .catch((error) => {
        console.error("Error loading layer:", error);
        showError(`Failed to load layer ${layerName}`);
      });
  }

  /**
   * Calculate Mean Absolute Error between a layer and QPE_target
   * @param {number} mapIndex - Index of the map panel
   * @param {string} layerName - Name of the layer to compare with QPE_target
   */
  function calculateMAE(mapIndex, layerName) {
    // Skip calculation if no data
    if (!allValueData || !allValueData["QPE_target"]) {
      // Remove any existing MAE display
      removeMAEDisplay(mapIndex);
      return;
    }

    // Get data for the current layer and target
    const layerData = allValueData[layerName];
    const targetData = allValueData["QPE_target"];

    if (!layerData || !targetData) {
      // Data not loaded yet
      removeMAEDisplay(mapIndex);
      return;
    }

    try {
      // Calculate MAE
      let totalError = 0;
      let validPoints = 0;

      // Both arrays should have the same dimensions
      for (let i = 0; i < layerData.length; i++) {
        for (let j = 0; j < layerData[i].length; j++) {
          // Only consider points where both values are valid (not null/undefined/NaN)
          const layerValue = layerData[i][j];
          const targetValue = targetData[i][j];

          if (
            layerValue !== null &&
            layerValue !== undefined &&
            targetValue !== null &&
            targetValue !== undefined &&
            !isNaN(layerValue) &&
            !isNaN(targetValue)
          ) {
            totalError += Math.abs(layerValue - targetValue);
            validPoints++;
          }
        }
      }

      // Calculate final MAE
      let mae = validPoints > 0 ? totalError / validPoints : 0;

      // Display MAE
      displayMAE(mapIndex, mae);
    } catch (error) {
      console.error("Error calculating MAE:", error);
      removeMAEDisplay(mapIndex);
    }
  }

  /**
   * Display MAE value in the map panel
   * @param {number} mapIndex - Index of the map panel
   * @param {number} mae - Mean Absolute Error value
   */
  function displayMAE(mapIndex, mae) {
    // Remove any existing MAE display
    removeMAEDisplay(mapIndex);

    // Create MAE display element
    const mapPanel = document.querySelector(
      `.map-panel:nth-child(${mapIndex + 1})`,
    );
    if (!mapPanel) return;

    const maeDisplay = document.createElement("div");
    maeDisplay.className = "mae-display";
    maeDisplay.id = `mae-display-${mapIndex}`;

    // Round to 4 decimal places
    maeDisplay.textContent = `MAE: ${mae.toFixed(4)}`;

    // Add to map panel
    mapPanel.appendChild(maeDisplay);
  }

  /**
   * Remove MAE display from a map panel
   * @param {number} mapIndex - Index of the map panel
   */
  function removeMAEDisplay(mapIndex) {
    const maeDisplay = document.getElementById(`mae-display-${mapIndex}`);
    if (maeDisplay) {
      maeDisplay.remove();
    }
  }

  /**
   * Update opacity for all layers
   */
  function updateLayerOpacity() {
    const opacity = parseFloat(document.getElementById("opacity-slider").value);
    for (let i = 0; i < mapOverlays.length; i++) {
      if (mapOverlays[i]) {
        mapOverlays[i].setOpacity(opacity);
      }
    }
    // Update percentage display
    const percent = Math.round(opacity * 100);
    const opacityValue = document.getElementById("opacity-value");
    if (opacityValue) {
      opacityValue.textContent = percent + "%";
    }
  }

  // Toggle credits popup visibility
  function toggleCredits(event) {
    event.stopPropagation();
    const creditsPopup = document.getElementById("credits-popup");
    const creditsButton = document.getElementById("credits-button");

    if (creditsVisible) {
      hideCredits();
    } else {
      creditsPopup.classList.remove("hidden");
      creditsButton.textContent = "Hide Credits";
      creditsVisible = true;
    }
  }

  // Hide credits popup
  function hideCredits() {
    const creditsPopup = document.getElementById("credits-popup");
    const creditsButton = document.getElementById("credits-button");

    creditsPopup.classList.add("hidden");
    creditsButton.textContent = "Show Credits";
    creditsVisible = false;
  }

  /**
   * Show error message
   */
  function showError(message, isMissingData = false) {
    const errorElement = document.getElementById("error-message");
    const errorParagraph = errorElement.querySelector("p");

    errorParagraph.textContent = message;

    if (isMissingData) {
      errorParagraph.classList.add("missing-data-error");
    } else {
      errorParagraph.classList.remove("missing-data-error");
    }

    errorElement.classList.remove("hidden");
  }
});
