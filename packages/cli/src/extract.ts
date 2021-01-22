import {warn, getStdinAsString} from './console_utils';
import {readFile, outputFile} from 'fs-extra';
import {
  interpolateName,
  Opts,
  MessageDescriptor,
} from '@formatjs/ts-transformer';

import {resolveBuiltinFormatter, Formatter} from './formatters';
import stringify from 'json-stable-stringify';
import {parseFile} from './vue_extractor';
import {parseScript} from './parse_script';
export interface ExtractionResult<M = Record<string, string>> {
  /**
   * List of extracted messages
   */
  messages: ExtractedMessageDescriptor[];
  /**
   * Metadata extracted w/ `pragma`
   */
  meta?: M;
}

export interface ExtractedMessageDescriptor extends MessageDescriptor {
  /**
   * Line number
   */
  line?: number;
  /**
   * Column number
   */
  col?: number;
  /**
   * Metadata extracted from pragma
   */
  meta?: Record<string, string>;
}

export interface MergedMessageDescriptor
  extends Omit<MessageDescriptor, 'file' | 'start' | 'end'> {
  locations?: Array<
    Pick<
      ExtractedMessageDescriptor,
      'col' | 'line' | 'meta' | 'file' | 'start' | 'end'
    >
  >;
}

export type ExtractCLIOptions = Omit<
  ExtractOpts,
  'overrideIdFn' | 'onMsgExtracted' | 'onMetaExtracted'
> & {
  /**
   * Output File
   */
  outFile?: string;
  /**
   * Ignore file glob pattern
   */
  ignore?: string[];
};

export type ExtractOpts = Opts & {
  /**
   * Whether to throw an error if we had any issues with
   * 1 of the source files
   */
  throws?: boolean;
  /**
   * Message ID interpolation pattern
   */
  idInterpolationPattern?: string;
  /**
   * Whether we read from stdin instead of a file
   */
  readFromStdin?: boolean;
  /**
   * Path to a formatter file that controls the shape of JSON file from `outFile`.
   */
  format?: string | Formatter;
} & Pick<Opts, 'onMsgExtracted' | 'onMetaExtracted'>;

function calculateLineColFromOffset(
  text: string,
  start?: number
): Pick<ExtractedMessageDescriptor, 'line' | 'col'> {
  if (!start) {
    return {line: 1, col: 1};
  }
  const chunk = text.slice(0, start);
  const lines = chunk.split('\n');
  const lastLine = lines[lines.length - 1];
  return {line: lines.length, col: lastLine.length};
}

function processFile(
  source: string,
  fn: string,
  {idInterpolationPattern, ...opts}: Opts & {idInterpolationPattern?: string}
) {
  let messages: ExtractedMessageDescriptor[] = [];
  let meta: Record<string, string> | undefined;

  opts = {
    ...opts,
    additionalComponentNames: [
      '$formatMessage',
      ...(opts.additionalComponentNames || []),
    ],
    onMsgExtracted(_, msgs) {
      if (opts.extractSourceLocation) {
        msgs = msgs.map(msg => ({
          ...msg,
          ...calculateLineColFromOffset(source, msg.start),
        }));
      }
      messages = messages.concat(msgs);
    },
    onMetaExtracted(_, m) {
      meta = m;
    },
  };

  if (!opts.overrideIdFn && idInterpolationPattern) {
    opts = {
      ...opts,
      overrideIdFn: (id, defaultMessage, description, fileName) =>
        id ||
        interpolateName(
          {
            resourcePath: fileName,
          } as any,
          idInterpolationPattern,
          {
            content: description
              ? `${defaultMessage}#${description}`
              : defaultMessage,
          }
        ),
    };
  }

  const scriptParseFn = parseScript(opts, fn);
  if (fn.endsWith('.vue')) {
    parseFile(source, fn, scriptParseFn);
  } else {
    scriptParseFn(source);
  }

  if (meta) {
    messages.forEach(m => (m.meta = meta));
  }
  return {messages, meta};
}

/**
 * Extract strings from source files
 * @param files list of files
 * @param extractOpts extract options
 * @returns messages serialized as JSON string since key order
 * matters for some `format`
 */
export async function extract(
  files: readonly string[],
  extractOpts: ExtractOpts
) {
  const {throws, readFromStdin, ...opts} = extractOpts;
  let rawResults: Array<ExtractionResult | undefined>;
  if (readFromStdin) {
    // Read from stdin
    if (process.stdin.isTTY) {
      warn('Reading source file from TTY.');
    }
    const stdinSource = await getStdinAsString();
    rawResults = [processFile(stdinSource, 'dummy', opts)];
  } else {
    rawResults = await Promise.all(
      files.map(async fn => {
        try {
          const source = await readFile(fn, 'utf8');
          return processFile(source, fn, opts);
        } catch (e) {
          if (throws) {
            throw e;
          } else {
            warn(e);
          }
        }
      })
    );
  }

  const formatter = await resolveBuiltinFormatter(opts.format);
  const extractionResults = rawResults.filter(
    (r): r is ExtractionResult => !!r
  );

  const extractedMessages = new Map<string, MergedMessageDescriptor>();

  for (const {messages} of extractionResults) {
    for (const message of messages) {
      const {id, description, defaultMessage} = message;
      if (!id) {
        const error = new Error(
          `[FormatJS CLI] Missing message id for message: 
${JSON.stringify(message, undefined, 2)}`
        );
        if (throws) {
          throw error;
        } else {
          warn(error.message);
        }
        continue;
      }

      if (extractedMessages.has(id)) {
        const existing = extractedMessages.get(id)!;
        if (
          description !== existing.description ||
          defaultMessage !== existing.defaultMessage
        ) {
          const error = new Error(
            `[FormatJS CLI] Duplicate message id: "${id}", ` +
              'but the `description` and/or `defaultMessage` are different.'
          );
          if (throws) {
            throw error;
          } else {
            warn(error.message);
          }
        }

        const {file, start, end, line, col, meta, ...restOrMessage} = message;
        const location = {
          file,
          start,
          end,
          line,
          col,
          meta,
        };
        const hasLocation =
          Object.values(location).filter(v => v !== undefined).length > 0;
        const locations = hasLocation
          ? (existing.locations || []).concat([location])
          : existing.locations;
        extractedMessages.set(id, {
          ...restOrMessage,
          locations,
        });
      }
      const {file, start, end, line, col, meta, ...restOrMessage} = message;
      const location = {
        file,
        start,
        end,
        line,
        col,
        meta,
      };
      const hasLocation =
        Object.values(location).filter(v => v !== undefined).length > 0;
      const locations = hasLocation ? [location] : undefined;
      extractedMessages.set(id, {
        ...restOrMessage,
        locations,
      });
    }
  }
  const results: Record<string, Omit<MergedMessageDescriptor, 'id'>> = {};
  const messages = Array.from(extractedMessages.values());
  for (const {id, ...msg} of messages) {
    results[id] = msg;
  }
  return stringify(formatter.format(results), {
    space: 2,
    cmp: formatter.compareMessages || undefined,
  });
}

/**
 * Extract strings from source files, also writes to a file.
 * @param files list of files
 * @param extractOpts extract options
 * @returns A Promise that resolves if output file was written successfully
 */
export default async function extractAndWrite(
  files: readonly string[],
  extractOpts: ExtractCLIOptions
) {
  const {outFile, ...opts} = extractOpts;
  const serializedResult = await extract(files, opts);
  if (outFile) {
    return outputFile(outFile, serializedResult);
  }
  process.stdout.write(serializedResult);
  process.stdout.write('\n');
}
