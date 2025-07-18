import * as Arr from "effect/Array";
import * as Micro from "effect/Micro";

import type { ExpandedRouteConfig, FetchEsque } from "@uploadthing/shared";
import {
  createIdentityProxy,
  FetchContext,
  fileSizeToBytes,
  matchFileType,
  objectKeys,
  resolveMaybeUrlArg,
  UploadAbortedError,
  UploadPausedError,
} from "@uploadthing/shared";

import * as pkgJson from "../package.json";
import type { Deferred } from "./_internal/deferred";
import { createDeferred } from "./_internal/deferred";
import { generateTraceHeaders } from "./_internal/random-hex";
import { uploadFile, uploadFilesInternal } from "./_internal/upload-browser";
import { createUTReporter } from "./_internal/ut-reporter";
import type {
  ClientUploadedFileData,
  CreateUploadOptions,
  EndpointArg,
  FileRouter,
  GenerateUploaderOptions,
  inferEndpointInput,
  inferEndpointOutput,
  NewPresignedUrl,
  RouteRegistry,
  UploadFilesOptions,
} from "./types";

export const version = pkgJson.version;

export {
  /** @public */
  generateClientDropzoneAccept,
  /** @public */
  generateMimeTypes,
  /** @public */
  generatePermittedFileTypes,
  /** @public */
  bytesToFileSize,
  /** @public */
  allowedContentTextLabelGenerator,
  /** @public */
  UploadAbortedError,
  /** @public */
  UploadPausedError,
} from "@uploadthing/shared";

/**
 * Validate that a file is of a valid type given a route config
 * @public
 */
export const isValidFileType = (
  file: File,
  routeConfig: ExpandedRouteConfig,
): boolean =>
  Micro.runSync(
    matchFileType(file, objectKeys(routeConfig)).pipe(
      Micro.map((type) => file.type.includes(type)),
      Micro.orElseSucceed(() => false),
    ),
  );

/**
 * Validate that a file is of a valid size given a route config
 * @public
 */
export const isValidFileSize = (
  file: File,
  routeConfig: ExpandedRouteConfig,
): boolean =>
  Micro.runSync(
    matchFileType(file, objectKeys(routeConfig)).pipe(
      Micro.flatMap((type) => fileSizeToBytes(routeConfig[type]!.maxFileSize)),
      Micro.map((maxFileSize) => file.size <= maxFileSize),
      Micro.orElseSucceed(() => false),
    ),
  );

/**
 * Generate a typed uploader for a given FileRouter
 * @public
 */
export const genUploader = <TRouter extends FileRouter>(
  initOpts?: GenerateUploaderOptions,
) => {
  const routeRegistry = createIdentityProxy<RouteRegistry<TRouter>>();

  const controllableUpload = async <
    TEndpoint extends keyof TRouter,
    TServerOutput = inferEndpointOutput<TRouter[TEndpoint]>,
  >(
    slug: EndpointArg<TRouter, TEndpoint>,
    opts: Omit<
      CreateUploadOptions<TRouter[TEndpoint]>,
      keyof GenerateUploaderOptions
    >,
  ) => {
    const uploads = new Map<
      File,
      {
        presigned: NewPresignedUrl;
        deferred: Deferred<ClientUploadedFileData<TServerOutput>>;
      }
    >();

    const endpoint = typeof slug === "function" ? slug(routeRegistry) : slug;

    const traceHeaders = generateTraceHeaders();
    const utReporter = createUTReporter({
      endpoint: String(endpoint),
      package: initOpts?.package ?? "uploadthing/client",
      url: resolveMaybeUrlArg(initOpts?.url),
      headers: opts.headers,
      traceHeaders,
    });
    const fetchFn: FetchEsque = initOpts?.fetch ?? window.fetch;

    const presigneds = await Micro.runPromise(
      utReporter("upload", {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        input: "input" in opts ? (opts.input as any) : null,
        files: opts.files.map((f) => ({
          name: f.name,
          size: f.size,
          type: f.type,
          lastModified: f.lastModified,
        })),
      }).pipe(Micro.provideService(FetchContext, fetchFn)),
    );

    const totalSize = opts.files.reduce((acc, f) => acc + f.size, 0);
    let totalLoaded = 0;

    const uploadEffect = (file: File, presigned: NewPresignedUrl) =>
      uploadFile(file, presigned, {
        traceHeaders,
        onUploadProgress: (progressEvent) => {
          totalLoaded += progressEvent.delta;
          opts.onUploadProgress?.({
            ...progressEvent,
            file,
            progress: Math.round((progressEvent.loaded / file.size) * 100),
            totalLoaded,
            totalProgress: Math.round((totalLoaded / totalSize) * 100),
          });
        },
      }).pipe(Micro.provideService(FetchContext, fetchFn));

    for (const [i, p] of presigneds.entries()) {
      const file = opts.files[i];
      if (!file) continue;

      const deferred = createDeferred<ClientUploadedFileData<TServerOutput>>();
      uploads.set(file, { deferred, presigned: p });

      void Micro.runPromiseExit(uploadEffect(file, p), {
        signal: deferred.ac.signal,
      })
        .then((result) => {
          if (result._tag === "Success") {
            return deferred.resolve(result.value);
          } else if (result.cause._tag === "Interrupt") {
            throw new UploadPausedError();
          }
          throw Micro.causeSquash(result.cause);
        })
        .catch((err) => {
          if (err instanceof UploadPausedError) return;
          deferred.reject(err);
        });
    }

    /**
     * Pause an ongoing upload
     * @param file The file upload you want to pause. Can be omitted to pause all files
     */
    const pauseUpload = (file?: File) => {
      const files = Arr.ensure(file ?? opts.files);
      for (const file of files) {
        const upload = uploads.get(file);
        if (!upload) return;

        if (upload.deferred.ac.signal.aborted) {
          // Cancel the upload if it's already been paused
          throw new UploadAbortedError();
        }

        upload.deferred.ac.abort();
      }
    };

    /**
     * Resume a paused upload
     * @param file The file upload you want to resume. Can be omitted to resume all files
     */
    const resumeUpload = (file?: File) => {
      const files = Arr.ensure(file ?? opts.files);
      for (const file of files) {
        const upload = uploads.get(file);
        if (!upload) throw "No upload found";

        upload.deferred.ac = new AbortController();
        void Micro.runPromiseExit(uploadEffect(file, upload.presigned), {
          signal: upload.deferred.ac.signal,
        })
          .then((result) => {
            if (result._tag === "Success") {
              return upload.deferred.resolve(result.value);
            } else if (result.cause._tag === "Interrupt") {
              throw new UploadPausedError();
            }
            throw Micro.causeSquash(result.cause);
          })
          .catch((err) => {
            if (err instanceof UploadPausedError) return;
            upload.deferred.reject(err);
          });
      }
    };

    /**
     * Wait for an upload to complete
     * @param file The file upload you want to wait for. Can be omitted to wait for all files
     */
    const done = async <T extends File | void = void>(
      file?: T,
    ): Promise<
      T extends File
        ? ClientUploadedFileData<TServerOutput>
        : ClientUploadedFileData<TServerOutput>[]
    > => {
      const promises = [];

      const files = Arr.ensure(file ?? opts.files);
      for (const file of files) {
        const upload = uploads.get(file);
        if (!upload) throw "No upload found";

        promises.push(upload.deferred.promise);
      }

      const results = await Promise.all(promises);
      return (file ? results[0] : results) as never;
    };

    return { pauseUpload, resumeUpload, done };
  };

  /**
   * One step upload function that both requests presigned URLs
   * and then uploads the files to UploadThing
   */
  const typedUploadFiles = <TEndpoint extends keyof TRouter>(
    slug: EndpointArg<TRouter, TEndpoint>,
    opts: Omit<
      UploadFilesOptions<TRouter[TEndpoint]>,
      keyof GenerateUploaderOptions
    >,
  ) => {
    const endpoint = typeof slug === "function" ? slug(routeRegistry) : slug;
    const fetchFn: FetchEsque = initOpts?.fetch ?? window.fetch;

    return uploadFilesInternal<TRouter, TEndpoint>(endpoint, {
      ...opts,
      skipPolling: {} as never, // Remove in a future version, it's type right not is an ErrorMessage<T> to help migrations.
      url: resolveMaybeUrlArg(initOpts?.url),
      package: initOpts?.package ?? "uploadthing/client",
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      input: (opts as any).input as inferEndpointInput<TRouter[TEndpoint]>,
    })
      .pipe(Micro.provideService(FetchContext, fetchFn), (effect) =>
        Micro.runPromiseExit(effect, opts.signal && { signal: opts.signal }),
      )
      .then((exit) => {
        if (exit._tag === "Success") {
          return exit.value;
        } else if (exit.cause._tag === "Interrupt") {
          throw new UploadAbortedError();
        }
        throw Micro.causeSquash(exit.cause);
      });
  };

  return {
    uploadFiles: typedUploadFiles,
    createUpload: controllableUpload,
    /**
     * Identity object that can be used instead of raw strings
     * that allows "Go to definition" in your IDE to bring you
     * to the backend definition of a route.
     */
    routeRegistry,
  };
};
