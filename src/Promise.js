import {slice, isArray, doFakeAutoComplete, miniTryCatch, setProps, setProp, _global} from './utils';
import {reverseStoppableEventChain, nop, callBoth, mirror} from './chaining-functions';
import Events from './Events';
import {debug, prettyStack, NEEDS_THROW_FOR_STACK} from './debug';

//
// Promise Class for Dexie library
//
// I started out writing this Promise class by copying promise-light (https://github.com/taylorhakes/promise-light) by
// https://github.com/taylorhakes - an A+ and ECMASCRIPT 6 compliant Promise implementation.
//
// Modifications needed to be done to support indexedDB because it wont accept setTimeout()
// (See discussion: https://github.com/promises-aplus/promises-spec/issues/45) .
// This topic was also discussed in the following thread: https://github.com/promises-aplus/promises-spec/issues/45
//
// This implementation will not use setTimeout or setImmediate when it's not needed. The behavior is 100% Promise/A+ compliant since
// the caller of new Promise() can be certain that the promise wont be triggered the lines after constructing the promise.
//
// In previous versions this was fixed by not calling setTimeout when knowing that the resolve() or reject() came from another
// tick. In Dexie v1.4.0, I've rewritten the Promise class entirely. Just some fragments of promise-light is left. I use
// another strategy now that simplifies everything a lot: to always execute callbacks in a new tick, but have an own microTick
// engine that is used instead of setImmediate() or setTimeout().
// Promise class has also been optimized a lot with inspiration from bluebird - to avoid closures as much as possible.
// Also with inspiration from bluebird, asyncronic stacks in debug mode.
//
// Specific non-standard features of this Promise class:
// * Async static context support (Promise.PSD)
// * Promise.follow() method built upon PSD, that allows user to track all promises created from current stack frame
//   and below + all promises that those promises creates or awaits.
// * Detect any unhandled promise in a PSD-scope (PSD.onunhandled). 
//
// David Fahlander, https://github.com/dfahlander
//

// Just a pointer that only this module knows about.
// Used in Promise constructor to emulate a private constructor.
var INTERNAL = {};

// Async stacks (long stacks) must not grow infinitely.
var LONG_STACKS_CLIP_LIMIT = 100,
    // When calling error.stack or promise.stack, limit the number of asyncronic stacks to print out. 
    MAX_LONG_STACKS = 20,
    stack_being_generated = false;

/* The default "nextTick" function used only for the very first promise in a promise chain.
   As soon as then promise is resolved or rejected, all next tasks will be executed in micro ticks
   emulated in this module. For indexedDB compatibility, this means that every method needs to 
   execute at least one promise before doing an indexedDB operation. Dexie will always call 
   db.ready().then() for every operation to make sure the indexedDB event is started in an
   emulated micro tick.
*/
var schedulePhysicalTick = (typeof setImmediate === 'undefined' ?
    // No support for setImmediate. No worry, setTimeout is only called
    // once time. Every tick that follows will be our emulated micro tick.
    // Could have uses setTimeout.bind(null, 0, physicalTick) if it wasnt for that FF13 and below has a bug 
    ()=>{setTimeout(physicalTick,0);} : 
    // setImmediate supported. Modern platform. Also supports Function.bind().
    setImmediate.bind(null, physicalTick));
        
// Confifurable through Promise.scheduler.
var asap = function (callback, args) {
    deferredCallbacks.push([callback, args]);
    if (needsNewPhysicalTick) {
        schedulePhysicalTick();
        needsNewPhysicalTick = false;
    }
}

var isOutsideMicroTick = true, // True when NOT in a virtual microTick.
    needsNewPhysicalTick = true, // True when a push to deferredCallbacks must also schedulePhysicalTick()
    unhandledErrors = [], // Rejected promises that has occured. Used for firing Promise.on.error and promise.onuncatched.
    currentFulfiller = null;
    
export var PSD = {
    global: true,
    ref: 0,
    unhandleds: [],
    onunhandled: globalError,
    env: null, // Will be set whenever leaving a scope using wrappers.snapshot()
    finalize: function () {
        this.unhandleds.forEach(uh => {
            try {
                globalError(uh[0], uh[1]);
            } catch (e) {}
        });
    }
};

export var deferredCallbacks = []; // Callbacks to call in this or next physical tick.
export var numScheduledCalls = 0; // Number of listener-calls left to do in this physical tick.
export var tickFinalizers = []; // Finalizers to call when there are no more async calls scheduled within current physical tick.

export var wrappers = (() => {
    var wrappers = [];

    return {
        snapshot: () => {
            var i = wrappers.length,
                result = new Array(i);
            while (i--) result[i] = wrappers[i].snapshot();
            return result;
        },
        restore: values => {
            var i = wrappers.length;
            while (i--) wrappers[i].restore(values[i]);
        },
        wrap: () => wrappers.map(w => w.wrap()),
        add: wrapper => {
            wrappers.push(wrapper);
        }
    };
})();

export default function Promise(fn) {
    if (typeof this !== 'object') throw new TypeError('Promises must be constructed via new');    
    this._listeners = [];
    
    // A library may set `promise._lib = true;` after promise is created to make resolve() or reject()
    // execute the microtask engine implicitely within the call to resolve() or reject().
    // To remain A+ compliant, a library must only set `_lib=true` if it can guarantee that the stack
    // only contains library code when calling resolve() or reject().
    // RULE OF THUMB: ONLY set _lib = true for promises explicitely resolving/rejecting directly from
    // global scope (event handler, timer etc)!
    this._lib = false;
    // Current async scope
    var psd = (this._PSD = PSD);

    if (debug) {
        if (NEEDS_THROW_FOR_STACK) try {
            // Doing something naughty in strict mode here to trigger a specific error
            // that can be explicitely ignored in debugger's exception settings.
            // If we'd just throw new Error() here, IE's debugger's exception settings
            // wouldn't let us explicitely ignore those errors.
            Promise.arguments;
        } catch(e) {
            this._stackHolder = e;
        } else {
            this._stackHolder = new Error();
        }
        this._prev = null;
        this._numPrev = 0; // Number of previous promises.
        linkToPreviousPromise(this, currentFulfiller);
    }
    
    if (typeof fn !== 'function') {
        if (fn !== INTERNAL) throw new TypeError('Not a function');
        // Private constructor (INTERNAL, state, value).
        // Used internally by Promise.resolve() and Promise.reject().
        this._state = arguments[1];
        this._value = arguments[2];
        return;
    }
    
    this._state = null; // null (=pending), false (=rejected) or true (=resolved)
    this._value = null; // error or result
    ++psd.ref; // Refcounting current scope
    executePromiseTask(this, fn);
}

setProps(Promise.prototype, {

    then: function (onFulfilled, onRejected) {
        var rv = new Promise((resolve, reject) => {
            propagateToListener(this, new Listener(onFulfilled, onRejected, resolve, reject));
        });
        debug && linkToPreviousPromise(rv, this);
        return rv;
    },

    catch: function (onRejected) {
        if (arguments.length === 1) return this.then(null, onRejected);
        // First argument is the Error type to catch
        var type = arguments[0], callback = arguments[1];
        if (typeof type === 'function') return this.then(null, function (e) {
            // Catching errors by its constructor type (similar to java / c++ / c#)
            // Sample: promise.catch(TypeError, function (e) { ... });
            if (e instanceof type) return callback(e); else return Promise.reject(e);
        });
        else return this.then(null, function (e) {
            // Catching errors by the error.name property. Makes sense for indexedDB where error type
            // is always DOMError but where e.name tells the actual error type.
            // Sample: promise.catch('ConstraintError', function (e) { ... });
            if (e && e.name === type) return callback(e); else return Promise.reject(e);
        });
    },

    finally: function (onFinally) {
        return this.then(function (value) {
            onFinally();
            return value;
        }, function (err) {
            onFinally();
            return Promise.reject(err);
        });
    },
    
    stack: {
        get: function() {
            if (this._stack) return this._stack;
            try {
                stack_being_generated = true;
                var stacks = getStack (this, [], MAX_LONG_STACKS);
                var stack = stacks.join("\nFrom previous:");
                if (this._state !== null) this._stack = stack; // Stack may be updated on reject.
                return stack;
            } finally {
                stack_being_generated = false;
            }
        }
    }    
});

function Listener(onFulfilled, onRejected, resolve, reject) {
    this.onFulfilled = typeof onFulfilled === 'function' ? onFulfilled : null;
    this.onRejected = typeof onRejected === 'function' ? onRejected : null;
    this.resolve = resolve;
    this.reject = reject;
    this.psd = PSD;
}

setProps (Promise, {
    all: function () {
        var args = slice(arguments.length === 1 && isArray(arguments[0]) ? arguments[0] : arguments);

        return new Promise(function (resolve, reject) {
            if (args.length === 0) return resolve([]);
            var remaining = args.length;
            function res(i, val) {
                try {
                    if (val && (typeof val === 'object' || typeof val === 'function')) {
                        var then = val.then;
                        if (typeof then === 'function') {
                            then.call(val, function (val) { res(i, val); }, reject);
                            return;
                        }
                    }
                    args[i] = val;
                    if (--remaining === 0) {
                        resolve(args);
                    }
                } catch (ex) {
                    reject(ex);
                }
            }
            for (var i = 0; i < args.length; i++) {
                res(i, args[i]);
            }
        });
    },
    
    resolve: value => {
        if (value && typeof value.then === 'function') return value;
        return new Promise(INTERNAL, true, value);
    },
    
    reject: reason => {
        return new Promise(INTERNAL, false, reason);
    },
    
    race: values => new Promise((resolve, reject) => {
        values.map(value => Promise.resolve(value).then(resolve, reject));
    }),
    
    PSD: {
        get: ()=>PSD,
        set: value => PSD = value
    },
    
    newPSD: newScope,
    
    usePSD: usePSD,
    
    scheduler: {
        get: () => asap,
        set: value => {asap = value}
    },
    
    rejectionMapper: mirror, // Map reject failures
            
    follow: fn => {
        return new Promise((resolve, reject) => {
            return newScope((resolve, reject) => {
                var psd = PSD;
                psd.unhandleds = []; // For unhandled standard- or 3rd party Promises. Checked at psd.finalize()
                psd.onunhandled = reject; // Triggered directly on unhandled promises of this library.
                psd.finalize = callBoth(function () {
                    // Unhandled standard or 3rd part promises are put in PSD.unhandleds and
                    // examined upon scope completion while unhandled rejections in this Promise
                    // will trigger directly through psd.onunhandled
                    run_at_end_of_this_or_next_physical_tick(()=>{
                        this.unhandleds.length === 0 ? resolve() : reject(this.unhandleds[0]);
                    });
                }, psd.finalize);
                fn();
            }, resolve, reject);
        });
    },

    // TODO: Remove:
    _rootExec: _rootExec,
    
    on: Events(null, {"error": [
        reverseStoppableEventChain,
        defaultErrorHandler] // Default to defaultErrorHandler
    }),
    
    // TODO: Remove!
    _isRootExec: {get: ()=> isOutsideMicroTick}
    
    //debug: {get: ()=>debug.de, set: val => debug = val},
});

/**
* Take a potentially misbehaving resolver function and make sure
* onFulfilled and onRejected are only called once.
*
* Makes no guarantees about asynchrony.
*/
function executePromiseTask (promise, fn) {
    // Promise Resolution Procedure:
    // https://github.com/promises-aplus/promises-spec#the-promise-resolution-procedure
    try {
        fn(value => {
            if (promise._state !== null) return;
            if (value === promise) throw new TypeError('A promise cannot be resolved with itself.');
            var shouldExecuteTick = promise._lib && beginMicroTickScope();
            if (value && (typeof value === 'object' || typeof value === 'function')) {
                if (typeof value.then === 'function') {
                    executePromiseTask(promise, (resolve, reject) => {
                        value instanceof Promise ?
                            propagateToListener(value, new Listener(null, null, resolve, reject)) :
                            value.then(resolve, reject);
                    });
                    if (shouldExecuteTick) endMicroTickScope();
                    return;
                }
            }
            promise._state = true;
            promise._value = value;
            propagateAllListeners(promise);
            if (shouldExecuteTick) endMicroTickScope();
        }, handleRejection.bind(null, promise)); // If Function.bind is not supported. Exception is thrown here
    } catch (ex) {
        handleRejection(promise, ex);
    }
}

function handleRejection (promise, reason) {
    if (promise._state !== null) return;
    var shouldExecuteTick = promise._lib && beginMicroTickScope();
    reason = Promise.rejectionMapper(reason);
    promise._state = false;
    promise._value = reason;
    debug && reason !== null && !reason._promise && typeof reason === 'object' && miniTryCatch(()=>{
        var origProp =
            Object.getOwnPropertyDescriptor(reason, "stack") ||
            Object.getOwnPropertyDescriptor(Object.getPrototypeOf(reason), "stack");
        
        reason._promise = promise;    
        setProp(reason, "stack", {
            get: () =>
                stack_being_generated ?
                    origProp && (origProp.get ?
                                origProp.get.apply(reason) :
                                origProp.value) :
                    promise.stack
        });
    });
    // Add the failure to a list of possibly uncaught errors
    addPossiblyUnhandledError(promise);
    propagateAllListeners(promise);
    if (shouldExecuteTick) endMicroTickScope();
}

function propagateAllListeners (promise) {
    //debug && linkToPreviousPromise(promise);
    for (var i = 0, len = promise._listeners.length; i < len; ++i) {
        propagateToListener(promise, promise._listeners[i]);
    }
    promise._listeners = [];
    var psd = promise._PSD;
    --psd.ref || psd.finalize(); // if psd.ref reaches zero, call psd.finalize();
    if (numScheduledCalls === 0) {
        // If numScheduledCalls is 0, it means that our stack is not in a callback of a scheduled call,
        // and that no deferreds where listening to this rejection or success.
        // Since there is a risk that our stack can contain application code that may
        // do stuff after this code is finished that may generate new calls, we cannot
        // call finalizers here.
        ++numScheduledCalls;
        asap(()=>{
            if (--numScheduledCalls === 0) finalizePhysicalTick(); // Will detect unhandled errors
        }, []);
    }
}
    
function propagateToListener(promise, listener) {
    if (promise._state === null) {
        promise._listeners.push(listener);
        return;
    }

    var cb = promise._state ? listener.onFulfilled : listener.onRejected;
    if (cb === null) {
        // This Listener doesnt have a listener for the event being triggered (onFulfilled or onReject) so lets forward the event to any eventual listeners on the Promise instance returned by then() or catch()
        return (promise._state ? listener.resolve : listener.reject)(promise._value);
    }
    var psd = listener.psd;
    ++psd.ref;
    ++numScheduledCalls;
    asap (callListener, [cb, promise, listener]);
}

function callListener (cb, promise, listener) {
    var outerScope = PSD;
    var psd = listener.psd;
    try {
        if (psd !== outerScope) {
            outerScope.env = wrappers.snapshot(); // Snapshot outerScope's environment.
            PSD = psd;
            wrappers.restore(psd.env); // Restore PSD's environment.
        }
        
        // Set static variable currentFulfiller to the promise that is being fullfilled,
        // so that we connect the chain of promises.
        currentFulfiller = promise;
        
        // Call callback and resolve our listener with it's return value.
        var ret = cb(promise._value);
        if (!promise._state && (                // This was a rejection and...
                !ret ||                         // handler didn't return something that could be a Promise
                !(ret instanceof Promise) ||    // handler didnt return a Promise
                ret._state !== false ||         // handler returned promise that didnt fail (yet at least)
                ret._value !== promise._value)) // handler didn't return a promise with same error as the one being rejected
            markErrorAsHandled (promise);       // If all above criterias are true, mark error as handled.

        listener.resolve(ret);
    } catch (e) {
        // Exception thrown in callback. Reject our listener.
        listener.reject(e);
    } finally {
        // Restore PSD, env and currentFulfiller.
        if (psd !== outerScope) {
            PSD = outerScope;
            wrappers.restore(outerScope.env); // Restore outerScope's environment
        }
        currentFulfiller = null;
        if (--numScheduledCalls === 0) finalizePhysicalTick();
        --psd.ref || psd.finalize();
    }
}

function getStack (promise, stacks, limit) {
    if (stacks.length === limit) return stacks;
    var stack = "";
    if (promise._state === false) {
        var failure = promise._value,
            errorName,
            message;
        
        if (failure != null) {
            errorName = failure.name || "Error";
            message = failure.message || failure;
            stack = prettyStack(failure, 1);
        } else {
            errorName = failure; // If error is undefined or null, show that.
            message = ""
        }
        stacks.push(errorName + (message ? ": " + message : "") + stack);
    }
    if (debug) {
        stack = prettyStack(promise._stackHolder, 2);
        if (stack && stacks.indexOf(stack) === -1) stacks.push(stack);
        if (promise._prev) getStack(promise._prev, stacks, limit);
    }
    return stacks;
}

function linkToPreviousPromise(promise, prev) {
    // Support long stacks by linking to previous completed promise.
    //console.log("linkPrev: " + prettyStack(promise._stackHolder, 2));
    var numPrev = prev ? prev._numPrev + 1 : 0;
    if (numPrev < LONG_STACKS_CLIP_LIMIT) { // Prohibit infinite Promise loops to get an infinite long memory consuming "tail".
        promise._prev = prev;
        promise._numPrev = numPrev;
    }
}

/* The callback to schedule with setImmediate() or setTimeout().
   It runs a virtual microtick and executes any callback registered in deferredCallbacks.
 */
function physicalTick() {
    beginMicroTickScope() && endMicroTickScope();
}

function beginMicroTickScope() {
    var wasRootExec = isOutsideMicroTick;
    isOutsideMicroTick = false;
    needsNewPhysicalTick = false;
    return wasRootExec;
}

function endMicroTickScope() {
    var callbacks, i, l;
    do {
        while (deferredCallbacks.length > 0) {
            callbacks = deferredCallbacks;
            deferredCallbacks = [];
            l = callbacks.length;
            for (i = 0; i < l; ++i) {
                var item = callbacks[i];
                item[0].apply(null, item[1]);
            }
        }
    } while (deferredCallbacks.length > 0);
    isOutsideMicroTick = true;
    needsNewPhysicalTick = true;
}

function finalizePhysicalTick() {
    unhandledErrors.forEach(p => {
        p._PSD.onunhandled.call(null, p._value, p);
    });
    unhandledErrors = [];
    var finalizers = tickFinalizers.slice(0); // Clone first because finalizer may remove itself from list.
    var i = finalizers.length;
    while (i) finalizers[--i]();    
}

function run_at_end_of_this_or_next_physical_tick (fn) {
    function finalizer() {
        fn();
        tickFinalizers.splice(tickFinalizers.indexOf(finalizer), 1);
    }
    tickFinalizers.push(finalizer);
    ++numScheduledCalls;
    asap(()=>{
        if (--numScheduledCalls === 0) finalizePhysicalTick();
    }, []);
}

// TODO: Remove!
function _rootExec(fn) {
    var isRootExec = beginMicroTickScope();
    try {
        return fn();
    } finally {
        if (isRootExec) endMicroTickScope();
    }
}

function addPossiblyUnhandledError(promise) {
    // Only add to unhandledErrors if not already there. The first one to add to this list
    // will be upon the first rejection so that the root cause (first promise in the
    // rejection chain) is the one listed.
    if (!unhandledErrors.some(p => p._value === promise._value))
        unhandledErrors.push(promise);
}

function markErrorAsHandled(promise) {
    // Called when a reject handled is actually being called.
    // Search in unhandledErrors for any promise whos _value is this promise_value (list
    // contains only rejected promises, and only one item per error)
    var i = unhandledErrors.length;
    while (i) if (unhandledErrors[--i]._value === promise._value) {
        // Found a promise that failed with this same error object pointer,
        // Remove that since there is a listener that actually takes care of it.
        unhandledErrors.splice(i, 1);
        return;
    }
}

// By default, log uncaught errors to the console
function defaultErrorHandler(e) {
    console.warn(`Uncaught Promise: ${e.stack || e}`);
}

export function wrap (fn, errorCatcher) {
    var psd = PSD;
    return function() {
        var wasRootExec = beginMicroTickScope(),
            outerScope = PSD;

        try {
            if (outerScope !== psd) {
                outerScope.env = wrappers.snapshot(); // Snapshot outerScope's environment
                PSD = psd;
                wrappers.restore(psd.env); // Restore PSD's environment.
            }
            return fn.apply(this, arguments);
        } catch (e) {
            errorCatcher && errorCatcher(e);
        } finally {
            if (outerScope !== psd) {
                PSD = outerScope;
                wrappers.restore(outerScope.env); // Restore outerScope's environment
            }
            if (wasRootExec) endMicroTickScope();
        }
    };
}
    
export function newScope (fn, a1, a2, a3) {
    var parent = PSD,
        psd = Object.create(parent);
    psd.parent = parent;
    psd.ref = 0;
    psd.global = false;
    psd.env = wrappers.wrap(psd);
    // unhandleds and onunhandled should not be specifically set here.
    // Leave them on parent prototype.
    // unhandleds.push(err) will push to parent's prototype
    // onunhandled() will call parents onunhandled (with this scope's this-pointer though!)
    ++parent.ref;
    psd.finalize = function () {
        --this.parent.ref || this.parent.finalize();
    }
    var rv = usePSD (psd, fn, a1, a2, a3);
    if (psd.ref === 0) psd.finalize();
    return rv;
}

export function usePSD (psd, fn, a1, a2, a3) {
    var outerScope = PSD;
    try {
        if (psd !== outerScope) {
            outerScope.env = wrappers.snapshot(); // snapshot outerScope's environment.
            PSD = psd;
            wrappers.restore(psd.env); // Restore PSD's environment.
        }
        return fn(a1, a2, a3);
    } finally {
        if (psd !== outerScope) {
            PSD = outerScope;
            wrappers.restore(outerScope.env); // Restore outerScope's environment.
        }
    }
}

function globalError(err, promise) {
    try {
        Promise.on.error.fire(err, promise); // TODO: Deprecated and use same global handler as bluebird.
    } catch (e) {}
}

/*

export function wrapPromise(PromiseClass) {
    var proto = PromiseClass.prototype;
    var origThen = proto.then;
    
    wrappers.add({
        snapshot: () => proto.then,
        restore: value => {proto.then = value;},
        wrap: () => patchedThen
    });

    function patchedThen (onFulfilled, onRejected) {
        var promise = this;
        var onFulfilledProxy = wrap(function(value){
            var rv = value;
            if (onFulfilled) {
                rv = onFulfilled(rv);
                if (rv && typeof rv.then === 'function') rv.then(); // Intercept that promise as well.
            }
            --PSD.ref || PSD.finalize();
            return rv;
        });
        var onRejectedProxy = wrap(function(err){
            promise._$err = err;
            var unhandleds = PSD.unhandleds;
            var idx = unhandleds.length,
                rv;
            while (idx--) if (unhandleds[idx]._$err === err) break;
            if (onRejected) {
                if (idx !== -1) unhandleds.splice(idx, 1); // Mark as handled.
                rv = onRejected(err);
                if (rv && typeof rv.then === 'function') rv.then(); // Intercept that promise as well.
            } else {
                if (idx === -1) unhandleds.push(promise);
                rv = PromiseClass.reject(err);
                rv._$nointercept = true; // Prohibit eternal loop.
            }
            --PSD.ref || PSD.finalize();
            return rv;
        });
        
        if (this._$nointercept) return origThen.apply(this, arguments);
        ++PSD.ref;
        return origThen.call(this, onFulfilledProxy, onRejectedProxy);
    }
}

// Global Promise wrapper
if (_global.Promise) wrapPromise(_global.Promise);

*/

doFakeAutoComplete(() => {
    // Simplify the job for VS Intellisense. This piece of code is one of the keys to the new marvellous intellisense support in Dexie.
    schedulePhysicalTick = () => {
        setTimeout(physicalTick, 0);
    };
});
