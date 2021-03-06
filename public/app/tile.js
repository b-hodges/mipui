const RENDERING_MESSAGE = 'Rendering, please wait...';
const EMPTY_IMAGE = 'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAA' +
    'C0lEQVQYV2NgAAIAAAUAAarVyFEAAAAASUVORK5CYII=';
let firstTileCacheStart = null;
// let tilesCached = 0;
const SQUARE_CELL = {
  [ck.kind]: ct.walls.smooth.id,
  [ck.variation]: ct.walls.smooth.square.id,
};
const pendingTiles = new Set();

class Tile {
  constructor(parent, key, x, y, index) {
    // Elements
    this.containerElement_ = createAndAppendDivWithClass(parent, 'tile');
    this.containerElement_.style.zIndex = 1000000 - index;
    this.mapElement =
        createAndAppendDivWithClass(this.containerElement_, 'tile-map');
    this.imageContainerElement_ = createAndAppendDivWithClass(
        this.containerElement_, 'tile-image-container');
    this.imageElement_ = document.createElement('img');
    this.imageElement_.className = 'tile-image';
    this.imageElement_.addEventListener('mouseenter', () => this.enter());
    this.imageContainerElement_.appendChild(this.imageElement_);
    this.gridLayer = createAndAppendDivWithClass(this.mapElement, 'grid-layer');

    // Identity and content
    this.key = key;
    this.x = x;
    this.y = y;
    this.cells = [];
    // layer -> element
    this.layerElements = new Map();
    this.firstCell = null;
    this.lastCell = null;

    // Geometry
    this.dimensionsInitialized_ = false;
    this.left = null;
    this.right = null;
    this.top = null;
    this.bottom = null;
    this.width = null;
    this.height = null;

    // Status
    this.active_ = false;
    this.interrupted_ = false;
    this.imageIsValid_ = false;
    this.timer_ = null;
    this.timerStartTime_ = null;
    this.locks_ = new Set();
  }

  initializeDimensions(left, top) {
    if (this.dimensionsInitialized_) return;
    this.dimensionsInitialized_ = true;
    this.left = left;
    this.top = top;
    this.containerElement_.style.left = left + 'px';
    this.containerElement_.style.top = top + 'px';
  }

  finalizeDimensions() {
    if (!this.lastCell) return;
    this.right = this.lastCell.offsetRight;
    this.bottom = this.lastCell.offsetBottom;
    this.width = this.lastCell.offsetLeft + this.lastCell.width - this.left;
    this.height = this.lastCell.offsetTop + this.lastCell.height - this.top;
    this.containerElement_.style.width = this.width + 'px';
    this.containerElement_.style.height = this.height + 'px';
    this.mapElement.style.width = this.width + 'px';
    this.mapElement.style.height = this.height + 'px';

    this.active_ = true;
    this.cacheImage_();
  }

  // Called when the cursor enters the tile
  enter() {
    this.lock_('cursor');
    // Sometimes the exit event isn't called because the browser doesn't
    // guarantee mouseexit. To prevent that from becoming an issue in the long
    // run, we occasionally exit() all other tiles upon tile entry.
    if (performance.now() % 10 == 0) {
      let count = 0;
      state.theMap.tiles.forEach(tile => {
        if (tile != this) {
          count += tile.exit() ? 1 : 0;
        }
      });
      if (count > 0) {
        debug(`Deactivating ${count} tiles stuck on 'cursor' lock.`);
      }
    }
    this.activate_();
  }

  // Called when the cursor leaves the tile
  exit() {
    return this.unlock_('cursor');
  }

  showHighlight() {
    this.lock_('highlight');
    this.activate_();
  }

  hideHighlight() {
    return this.unlock_('highlight');
  }

  // Called when an element that this tile contains (directly or as a replica)
  // has changed.
  invalidate() {
    this.interrupted_ = true;
    this.imageIsValid_ = false;
    this.activate_();
  }

  // Called when we want to prevent this tile from being cached.
  lock_(id) {
    if (this.locks_.has(id)) return;
    this.locks_.add(id);
    if (this.locks_.size == 1) this.interrupted_ = true;
    this.stopTimer_();
  }

  // Called when we no longer want to prevent caching of this tile.
  unlock_(id) {
    const wasRemoved = this.locks_.delete(id);
    this.restartTimer_();
    return wasRemoved;
  }

  activate_() {
    if (!this.active_) {
      this.containerElement_.appendChild(this.mapElement);
      this.imageContainerElement_.style.visibility = 'hidden';
      if (state.cachedTilesGreyedOut) {
        this.containerElement_.style.filter = '';
      }
      // debug(`Tile ${this.key} activated.`);
      this.active_ = true;
    }
    this.restartTimer_();
  }

  deactivate_(start) {
    if (!this.active_) return;
    pendingTiles.delete(this);
    if (pendingTiles.size < 5) {
      state.progressStatusBar.resetProgress();
    } else {
      state.progressStatusBar.incrementProgress(RENDERING_MESSAGE);
    }

    this.imageContainerElement_.style.visibility = 'visible';
    this.containerElement_.removeChild(this.mapElement);
    if (state.cachedTilesGreyedOut) {
      this.containerElement_.style.filter = 'grayscale(1)';
    }
    this.imageIsValid_ = true;
    this.active_ = false;
    this.interrupted_ = false;
    // const duration = Math.ceil(performance.now() - start);
    // debug(`Deactivated tile ${this.key} in ${duration}ms.`);
  }

  cacheImage_() {
    if (!state.tilingCachingEnabled) return;
    if (this.isLocked_()) return;
    this.interrupted_ = false;
    const start = performance.now();
    if (!firstTileCacheStart) firstTileCacheStart = performance.now();
    if (this.imageIsValid_) {
      // debug(`Matched tile ${this.key} with the cached image.`);
      this.deactivate_(start);
      return;
    }
    if (state.tilingEnabled) {
      if (this.isTileEmpty_()) {
        this.imageElement_.src = EMPTY_IMAGE;
        this.imageElement_.style.width = (2 + this.width) + 'px';
        this.imageElement_.style.height = (2 + this.height) + 'px';
        this.deactivate_(start);
        return;
      }
      const imageFromTheme = this.getImageFromTheme_();
      if (imageFromTheme) {
        this.imageElement_.src = imageFromTheme;
        this.imageElement_.style.width = (constants.tileSize * 32) + 'px';
        this.imageElement_.style.height = (constants.tileSize * 32) + 'px';
        this.deactivate_(start);
        return;
      }
    }
    if (state.theMap.concurrentTileCachingOperations >
        constants.concurrentTileCachingOperationsLimit) {
      this.restartTimer_();
      return;
    }
    state.theMap.concurrentTileCachingOperations++;
    if (!state.isReadOnly()) {
      this.mapElement.classList.add('editor-view');
    }
    this.lock_('caching');
    this.interrupted_ = false;
    state.tileGridImager
        .node2pngDataUrl(this.mapElement, this.width, this.height)
        .then(dataUrl => {
          state.theMap.concurrentTileCachingOperations--;
          this.unlock_('caching');
          if (this.isLocked_() || this.interrupted_) {
            this.restartTimer_();
            return;
          }
          this.imageElement_.src = dataUrl;
          this.imageElement_.style.width = (2 + this.width) + 'px';
          this.imageElement_.style.height = (2 + this.height) + 'px';
          this.deactivate_(start);
        }).catch(reason => {
          state.theMap.concurrentTileCachingOperations--;
          this.unlock_('caching');
          this.restartTimer_();
          debug(`Tile ${this.key} caching failed: ${reason}.`);
        });
  }

  restartTimer_() {
    if (this.timer_ && this.timerStartTime_ &&
        performance.now() - this.timerStartTime_ < 5) {
      // We do not restart timers if less than 5ms passed since the timer start.
      // Although this has the potential to accumulate into a problem, in
      // practice it never causes issues.
      return;
    }
    this.stopTimer_();
    if (!this.active_) return;
    if (this.locks_.size > 0) return;
    if (state.theMap.areTilesLocked()) {
      state.theMap.addTileUnlockListener(this, () => this.restartTimer_());
      return;
    }
    pendingTiles.add(this);
    if (pendingTiles.size > 25) {
      state.progressStatusBar.showProgress(
          RENDERING_MESSAGE, pendingTiles.size);
    } else if (pendingTiles.size < 5) {
      state.progressStatusBar.resetProgress();
    }
    this.timerStartTime_ = performance.now();
    this.timer_ = setTimeout(() => this.cacheImage_(), this.getTimerLength_());
  }

  stopTimer_() {
    if (this.timer_) {
      clearTimeout(this.timer_);
      pendingTiles.delete(this);
      state.theMap.removeTileUnlockListener(this);
    }
    this.timer_ = null;
    this.timerStartTime_ = null;
  }

  isLocked_() {
    return this.locks_.size > 0 || state.theMap.areTilesLocked();
  }

  getTimerLength_() {
    return 2000 + Math.random() * 2000;
  }

  isTileEmpty_() {
    return ct.children.every(layer =>
      this.layerElements.get(layer).childElementCount == 0
    );
  }

  getImageFromTheme_() {
    const fullTileImage =
        state.currentTheme[`fullTile${constants.tileSize}Src`];
    if (fullTileImage) {
      const tileOnlyHasWalls = ct.children.every(layer =>
        layer == ct.walls ||
        this.layerElements.get(layer).childElementCount == 0
      );
      // For early termination, we require the wall layer to have at least the
      // number of elements as the number of grid cells.
      if (this.layerElements.get(ct.walls).childElementCount <
          this.gridLayer.childElementCount) {
        return null;
      }
      const allOwnedCellsAreSquareWalls =
          this.cells.every(
              cell => sameContent(cell.getLayerContent(ct.walls), SQUARE_CELL));
      if (tileOnlyHasWalls && allOwnedCellsAreSquareWalls) {
        // debug(`Matched tile ${this.key} with the full tile image.`);
        return fullTileImage;
      }
    }
    return null;
  }
}
