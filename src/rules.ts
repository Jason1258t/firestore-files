import { resolveConfig, type FileStoreConfig, type ResolvedConfig } from './config.ts';

/**
 * Генератор правил Firestore для хранилища. Блок вставляется внутрь
 * `match /databases/{database}/documents { … }` между маркерами:
 *
 *     // firestore-files:begin <collection>
 *     // firestore-files:end <collection>
 */

const begin = (c: string) => `// firestore-files:begin ${c}`;
const end = (c: string) => `// firestore-files:end ${c}`;

function substitute(expr: string, file: string, isNew = 'request.resource.data') {
  return expr
    .replaceAll('$owner', `(${file}.uid == request.auth.uid)`)
    .replaceAll('$file', file)
    .replaceAll('$new', isNew);
}

export function generateRules(input: FileStoreConfig, indent = '    '): string {
  const c: ResolvedConfig = resolveConfig(input);
  const r = c.rules;
  const parent = 'ffParent()';
  const ownerNew = c.owner ? '\n    && d.uid == request.auth.uid' : '';
  const ownerExisting = (file: string) => (c.owner ? ` && ${file}.uid == request.auth.uid` : '');

  const lines = `${begin(c.collection)}
// Сгенерировано firestore-files — не править руками, перегенерировать: npx firestore-files rules
// maxFileSize=${c.maxFileSize} chunkSize=${c.chunkSize} maxChunks=${c.maxChunks} owner=${c.owner}
match /${c.collection}/{fileId} {
  function ffValidNew() {
    let d = request.resource.data;
    return d.keys().hasAll(['name', 'size', 'type', 'chunks', 'complete', 'createdAt'])
      && d.name is string && d.name.size() > 0 && d.name.size() <= 255
      && d.type is string && d.type.size() <= 255
      && d.size is int && d.size >= 0 && d.size <= ${c.maxFileSize}
      && d.chunks is int && d.chunks >= 1 && d.chunks <= ${c.maxChunks}
      && d.size <= d.chunks * ${c.chunkSize}
      && (d.chunks == 1 || d.size > (d.chunks - 1) * ${c.chunkSize})
      && d.complete == false
      && d.createdAt is int
      && (!('sha256' in d) || (d.sha256 is string && d.sha256.size() == 64))${ownerNew};
  }
  function ffParentPath() {
    return /databases/$(database)/documents/${c.collection}/$(fileId);
  }
  function ffParent() {
    return get(ffParentPath()).data;
  }

  allow read: if ${substitute(r.read, 'resource.data')};
  allow create: if (${r.write}) && ffValidNew() && (${substitute(r.validate, 'resource.data')});
  // Единственное изменение — отметка «все куски записаны»
  allow update: if (${r.write})${ownerExisting('resource.data')}
    && resource.data.complete == false
    && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['complete'])
    && request.resource.data.complete == true;
  allow delete: if ${substitute(r.delete, 'resource.data')};

  match /${c.chunksCollection}/{n} {
    allow read: if ${substitute(r.read, parent)};
    // Куски пишутся только в незавершённый файл, по своему номеру и не больше chunkSize
    allow create: if (${r.write})${ownerExisting(parent)}
      && ${parent}.complete == false
      && request.resource.data.keys().hasOnly(['i', 'data'])
      && request.resource.data.i is int
      && request.resource.data.i >= 0
      && request.resource.data.i < ${parent}.chunks
      && n == string(request.resource.data.i)
      && request.resource.data.data is bytes
      && request.resource.data.data.size() <= ${c.chunkSize};
    // Осиротевшие куски (метаданные уже удалены) может убрать кто угодно
    allow delete: if !exists(ffParentPath()) || ${substitute(r.delete, parent)};
  }
}
${end(c.collection)}`;
  return lines
    .split('\n')
    .map((l) => (l ? indent + l : l))
    .join('\n');
}

/**
 * Вставляет блоки в текст firestore.rules: заменяет содержимое между маркерами.
 * Если маркеров для коллекции нет — ошибка с подсказкой, куда их поставить.
 */
export function injectRules(source: string, configs: FileStoreConfig | FileStoreConfig[]): string {
  let out = source;
  for (const cfg of Array.isArray(configs) ? configs : [configs]) {
    const b = begin(cfg.collection);
    const e = end(cfg.collection);
    const from = out.indexOf(b);
    const to = out.indexOf(e);
    if (from < 0 || to < from)
      throw new Error(
        `В firestore.rules нет маркеров для «${cfg.collection}». Добавьте внутрь match /databases/{database}/documents:\n\n    ${b}\n    ${e}\n`,
      );
    const lineStart = out.lastIndexOf('\n', from) + 1;
    const indent = out.slice(lineStart, from);
    out = out.slice(0, lineStart) + generateRules(cfg, indent) + out.slice(to + e.length);
  }
  return out;
}
