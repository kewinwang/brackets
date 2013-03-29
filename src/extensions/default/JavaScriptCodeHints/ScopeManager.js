/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

/*
 * Throughout this file, the term "outer scope" is used to refer to the outer-
 * most/global/root Scope objects for particular file. The term "inner scope"
 * is used to refer to a Scope object that is reachable via the child relation
 * from an outer scope.
 */

/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, brackets, $, Worker */

define(function (require, exports, module) {
    "use strict";

    var DocumentManager     = brackets.getModule("document/DocumentManager"),
        LanguageManager     = brackets.getModule("language/LanguageManager"),
        FileUtils           = brackets.getModule("file/FileUtils"),
        NativeFileSystem    = brackets.getModule("file/NativeFileSystem").NativeFileSystem,
        ProjectManager      = brackets.getModule("project/ProjectManager"),
        HintUtils           = require("HintUtils"),
        Scope               = require("Scope"),
        Tern                = require("tern/tern");

    var pendingRequest      = null,     // information about a deferred scope request
        fileState           = {},       // directory -> file -> state
        ternEnvironment     = [],
        pendingTernRequests = {},
        rootTernDir             = null,
        ternWorker          = (function () {
            var path = module.uri.substring(0, module.uri.lastIndexOf("/") + 1);
            return new Worker(path + "tern-worker.js");
        }());

    var MAX_TEXT_LENGTH     = 1000000, // about 1MB
        MAX_FILES_IN_DIR    = 100;

    /**
     * Create a new tern server.
     */
    function initTernServer(dir, files) {
        ternWorker.postMessage({
                    type        : HintUtils.TERN_INIT_MSG,
                    dir         : dir,
                    files       : files,
                    env         : ternEnvironment
                });
        rootTernDir = dir;
    }
    
    /**
     * Read in the json files that have type information for the builtins, dom,etc
     */
    function initTernEnv() {
        var path = module.uri.substring(0, module.uri.lastIndexOf("/") + 1) + "tern/defs/";
        var files = ["ecma5.json", "browser.json"];//, "plugin/requirejs/requirejs.json", "jquery.json"];
        
        var dirEntry    = new NativeFileSystem.DirectoryEntry(path),
            reader      = dirEntry.createReader();
        
        files.forEach(function(i) {
            DocumentManager.getDocumentForPath(path + i).done(function(document){
                ternEnvironment.push(JSON.parse(document.getText()));
            }).fail(function(error){
                console.log("failed to read tern config file " + i);
            });
        });
    }

    initTernEnv();
    
    /** 
     * Initialize state for a given directory and file name
     *
     * @param {string} dir - the directory name to initialize
     * @param {string} file - the file name to initialize
     */
    function initFileState(dir, file) {
        // initialize outerScope, etc. at dir
        if (!fileState.hasOwnProperty(dir)) {
            fileState[dir] = {};
        }

        if (file !== undefined) {
            if (!fileState[dir].hasOwnProperty(file)) {
                fileState[dir][file] = {
                    // has the file changed since the scope was updated?
                    dirtyFile       : true,

                    // has the scope changed since the last inner scope request?
                    dirtyScope      : true,

                    // is the parser worker active for this file?
                    active          : false
                };
            }
        }
    }

    /**
     * Get the file state for a given path. If just the directory is given
     * instead of the whole path, a set of file states is returned, one for
     * each (known) file in the directory.
     * 
     * @param {string} dir - the directory name for which state is desired
     * @param {string=} file - the file name for which state is desired
     * @return {Object} - a file state object (as documented within 
     *      intializeFileState above), or a set of file state objects if
     *      file is omitted.
     */
    function getFileState(dir, file) {
        initFileState(dir, file);

        if (file === undefined) {
            return fileState[dir];
        } else {
            return fileState[dir][file];
        }
    }

    /**
     * Request hints from Tern.
     *
     * Note that successive calls to getScope may return the same objects, so
     * clients that wish to modify those objects (e.g., by annotating them based
     * on some temporary context) should copy them first. See, e.g.,
     * Session.getHints().
     * 
     * @param {Document} document - the document for which scope info is 
     *      desired
     * @param {number} offset - the offset into the document at which scope
     *      info is desired
     * @return {jQuery.Promise} - The promise will not complete until the tern
     *      hints have completed.
     */
    function requestHints(session, document, offset) {
        var path    = document.file.fullPath,
            split   = HintUtils.splitPath(path),
            dir     = split.dir,
            file    = split.file;
        
        var $deferredHints = $.Deferred(),
            ternPromise = getTernHints(dir, file, offset, document.getText());
        
        $.when(ternPromise).done(
            function(ternHints){
                session.setTernHints(ternHints);
                $deferredHints.resolveWith(null);
            });
        return {promise:$deferredHints.promise()};
    }

    /**
     * Get a Promise for the completions from TernJS, for the file & offset passed in.
     * @return {jQuery.Promise} - a promise that will resolve to an array of completions when
     *      it is done
     */
    function getTernHints(dir, file, offset, text) {
        ternWorker.postMessage({
            type: HintUtils.TERN_COMPLETIONS_MSG,
            dir:dir,
            file:file,
            offset:offset,
            text:text
        });

        var $deferredHints = $.Deferred();
        pendingTernRequests[file] = $deferredHints;
        return $deferredHints.promise();
    }
    
    /**
     * Handle the response from the tern web worker when
     * it responds with the list of completions
     *
     * @param {{dir:string, file:string, offset:number, completions:Array.<string>}} response - the response from the worker
     */
    function handleTernCompletions(response) {
        
        var dir = response.dir,
            file = response.file,
            offset = response.offset,
            completions = response.completions,
            $deferredHints = pendingTernRequests[file];
        
        pendingTernRequests[file] = null;
        
        if( $deferredHints ) { 
            $deferredHints.resolveWith(null, [completions]);
        }
    }
    
    /**
     * Handle a request from the worker for text of a file
     *
     * @param {{file:string}} request - the request from the worker.  Should be an Object containing the name
     *      of the file tern wants the contents of 
     */
    function handleTernGetFile(request) {
        var name = request.file;
        DocumentManager.getDocumentForPath(rootTernDir + name).done(function(document){
            ternWorker.postMessage({
                type:HintUtils.TERN_GET_FILE_MSG,
                file:name, 
                text:document.getText()
            });
        })

    }
    
    /**
     * Is the inner scope dirty? (It is if the outer scope has changed since
     * the last inner scope request)
     * 
     * @param {Document} document - the document for which the last requested
     *      inner scope may or may not be dirty
     * @return {boolean} - is the inner scope dirty?
     */
    function isScopeDirty(document) {
        var path    = document.file.fullPath,
            split   = HintUtils.splitPath(path),
            dir     = split.dir,
            file    = split.file,
            state   = getFileState(dir, file);
        
        return state.dirtyScope;
    }

    /**
     * Mark a file as dirty, which may cause a later outer scope request to
     * trigger a reparse request. 
     * 
     * @param {string} dir - the directory name of the file to be marked dirty
     * @param {string} file - the file name of the file to be marked dirty
     */
    function markFileDirty(dir, file) {
        var state = getFileState(dir, file);

        state.dirtyFile = true;
    }

    /**
     * Called each time a new editor becomes active. Refreshes the outer scopes
     * of the given file as well as of the other files in the given directory.
     * 
     * @param {Document} document - the document of the editor that has changed
     */
    function handleEditorChange(document) {
        var path        = document.file.fullPath,
            split       = HintUtils.splitPath(path),
            dir         = split.dir,
            file        = split.file,
            dirEntry    = new NativeFileSystem.DirectoryEntry(dir),
            reader      = dirEntry.createReader(),
            files       = [];
        
        markFileDirty(dir, file);

        reader.readEntries(function (entries) {
            entries.slice(0, MAX_FILES_IN_DIR).forEach(function (entry) {
                if (entry.isFile) {
                    var path    = entry.fullPath,
                        split   = HintUtils.splitPath(path),
                        dir     = split.dir,
                        file    = split.file;
                    
                    if (file.indexOf(".") > 1) { // ignore /.dotfiles
                        var mode = LanguageManager.getLanguageForPath(entry.fullPath).getMode();
                        if (mode === HintUtils.MODE_NAME) {
                            files.push(file);
                        }
                    }
                }
            });
            initTernServer(dir, files);
        }, function (err) {
            console.log("Unable to refresh directory: " + err);
        });
        
    }

    /*
     * Called each time the file associated with the active editor changes.
     * Marks the file as being dirty and refresh its outer scope.
     * 
     * @param {Document} document - the document that has changed
     */
    function handleFileChange(document) {
        var path    = document.file.fullPath,
            split   = HintUtils.splitPath(path),
            dir     = split.dir,
            file    = split.file;
        
        markFileDirty(dir, file);
    }

    ternWorker.addEventListener("message", function (e) {
        var response = e.data,
            type = response.type;
        
        if( type === HintUtils.TERN_COMPLETIONS_MSG) {
            // handle any completions the worker calculated
            handleTernCompletions(response);
        } else if ( type === HintUtils.TERN_GET_FILE_MSG ) {
            // handle a request for the contents of a file
            handleTernGetFile(response);
        } else {
            console.log("Worker: " + (response.log || response));
        }
    });
    
    // reset state on project change
    $(ProjectManager)
        .on(HintUtils.eventName("beforeProjectClose"),
            function (event, projectRoot) {
                fileState = {};
            });
    
    // relocate scope information on file rename
    $(DocumentManager)
        .on(HintUtils.eventName("fileNameChange"),
            function (event, oldName, newName) {
                var oldSplit    = HintUtils.splitPath(oldName),
                    oldDir      = oldSplit.dir,
                    oldFile     = oldSplit.file,
                    newSplit    = HintUtils.splitPath(newName),
                    newDir      = newSplit.dir,
                    newFile     = newSplit.file;
        
                if (fileState.hasOwnProperty(oldDir) &&
                        fileState[oldDir].hasOwnProperty(oldFile)) {
                    if (!fileState.hasOwnProperty(newDir)) {
                        fileState[newDir] = {};
                    }
                    fileState[newDir][newFile] = fileState[oldDir][oldFile];
                    delete fileState[oldDir][oldFile];
                }
            });

    
    exports.handleEditorChange = handleEditorChange;
    exports.handleFileChange = handleFileChange;
    exports.requestHints = requestHints;
    exports.isScopeDirty = isScopeDirty;
    exports.getTernHints = getTernHints;
});
