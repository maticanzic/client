'use strict';

const buildThread = require('../build-thread');
const events = require('../events');
const memoize = require('../util/memoize');
const metadata = require('../util/annotation-metadata');
const tabs = require('../util/tabs');

function truthyKeys(map) {
  return Object.keys(map).filter(function(k) {
    return !!map[k];
  });
}

// Mapping from sort order name to a less-than predicate
// function for comparing annotations to determine their sort order.
const sortFns = {
  Newest: function(a, b) {
    return a.updated > b.updated;
  },
  Oldest: function(a, b) {
    return a.updated < b.updated;
  },
  Location: function(a, b) {
    return metadata.location(a) < metadata.location(b);
  },
  Top: function(a, b) {
    return a.voteResult > b.voteResult;
  },
  Hot: function(a, b) {
    return hotSortScore(a) > hotSortScore(b);
  },
  Best: function(a, b) {
    return bestSortScore(a) > bestSortScore(b);
  },
};

/**
* Helper functions for sorting algorithms
*/

// Hot sort algorithm

function hotSortScore(annotation) {
  var t0 = performance.now();
  
  let s = annotation.voteResult;
  let order = Math.log(Math.max(Math.abs(s), 1)) / Math.LN10;
  let sign;
  
  if (s == 0) {
    sign = 0;
  } else if (s < 0) {
    sign = -1;
  } else {
    sign = 1;
  }

  let seconds = epochTimeDifference(annotation.created) - 1134028003;

  var t1 = performance.now();
  return (sign * order + seconds / 45000);
}

// Time delta between the time when annotation is posted and epoch

function epochTimeDifference(date) {
  let secondsSinceEpoch = Math.floor(new Date().getTime() / 1000);
  let dateToConvert = new Date(date);
  let dateToSeconds = dateToConvert.getTime() / 1000;

  return dateToSeconds - secondsSinceEpoch;
}

// Best sort algorithm

function bestSortScore(annotation) {
  let numberOfRatings = annotation.upvotes + annotation.downvotes;

  if (numberOfRatings == 0) {
    return 0;
  } else {
    // Standard normal distribution constant
    const z = 1.281551565545;

    // a share of positive ratings among all votes
    let positiveShare = annotation.upvotes / numberOfRatings;

    // Wilson score interval equation consists of three parts
    let upperLeftEquation = positiveShare + 1 / (2 + numberOfRatings) * Math.pow(z, 2);
    let upperRightEquation = z * Math.sqrt(positiveShare * (1 - positiveShare) / numberOfRatings + Math.pow(z, 2) / (4 * Math.pow(numberOfRatings, 2)));
    let bottomEquation = 1 + 1 / numberOfRatings * Math.pow(z, 2);

    return (upperLeftEquation - upperRightEquation) / bottomEquation;
  }
}


/**
 * Root conversation thread for the sidebar and stream.
 *
 * This performs two functions:
 *
 * 1. It listens for annotations being loaded, created and unloaded and
 *    dispatches store.{addAnnotations|removeAnnotations} actions.
 * 2. Listens for changes in the UI state and rebuilds the root conversation
 *    thread.
 *
 * The root thread is then displayed by viewer.html
 */
// @ngInject
function RootThread($rootScope, store, searchFilter, viewFilter) {
  /**
   * Build the root conversation thread from the given UI state.
   *
   * @param state - The current UI state (loaded annotations, sort mode,
   *        filter settings etc.)
   */
  function buildRootThread(state) {
    console.time('SortResult - ' + state.sortKey);
    const sortFn = sortFns[state.sortKey];
    const shouldFilterThread = () => {
      // Is there a search query, or are we in an active (focused) focus mode?
      return state.filterQuery || store.focusModeFocused();
    };
    let filterFn;
    if (shouldFilterThread()) {
      const filters = searchFilter.generateFacetedFilter(state.filterQuery, {
        // if a focus mode is applied (focused) and we're focusing on a user
        user: store.focusModeFocused() && store.focusModeUsername(),
      });

      filterFn = function(annot) {
        return viewFilter.filter([annot], filters).length > 0;
      };
    }

    let threadFilterFn;
    if (state.isSidebar && !shouldFilterThread()) {
      threadFilterFn = function(thread) {
        if (!thread.annotation) {
          return false;
        }

        return tabs.shouldShowInTab(thread.annotation, state.selectedTab);
      };
    }
    console.timeEnd('SortResult - ' + state.sortKey);
    // Get the currently loaded annotations and the set of inputs which
    // determines what is visible and build the visible thread structure
    return buildThread(state.annotations, {
      forceVisible: truthyKeys(state.forceVisible),
      expanded: state.expanded,
      highlighted: state.highlighted,
      selected: truthyKeys(state.selectedAnnotationMap || {}),
      sortCompareFn: sortFn,
      filterFn: filterFn,
      threadFilterFn: threadFilterFn,
    });
  }

  // Listen for annotations being created or loaded
  // and show them in the UI.
  //
  // Note: These events could all be converted into actions that are handled by
  // the Redux store in store.
  const loadEvents = [
    events.ANNOTATION_CREATED,
    events.ANNOTATION_UPDATED,
    events.ANNOTATIONS_LOADED,
  ];
  loadEvents.forEach(function(event) {
    $rootScope.$on(event, function(event, annotation) {
      store.addAnnotations([].concat(annotation));
    });
  });

  $rootScope.$on(events.BEFORE_ANNOTATION_CREATED, function(event, ann) {
    store.createAnnotation(ann);
  });

  // Remove any annotations that are deleted or unloaded
  $rootScope.$on(events.ANNOTATION_DELETED, function(event, annotation) {
    store.removeAnnotations([annotation]);
  });

  $rootScope.$on(events.ANNOTATIONS_UNLOADED, function(event, annotations) {
    store.removeAnnotations(annotations);
  });

  // Once the focused group state is moved to the app state store, then the
  // logic in this event handler can be moved to the annotations reducer.
  $rootScope.$on(events.GROUP_FOCUSED, function(event, focusedGroupId) {
    const updatedAnnots = store
      .getState()
      .annotations.filter(function(ann) {
        return metadata.isNew(ann) && !metadata.isReply(ann);
      })
      .map(function(ann) {
        return Object.assign(ann, {
          group: focusedGroupId,
        });
      });
    if (updatedAnnots.length > 0) {
      store.addAnnotations(updatedAnnots);
    }
  });

  /**
   * Build the root conversation thread from the given UI state.
   * @return {Thread}
   */
  this.thread = memoize(buildRootThread);
}

module.exports = RootThread;
