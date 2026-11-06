import { AttachmentLimitError, checkImageBudget, MAX_IMAGE_BYTES, MAX_TEXT_FILE_BYTES, MAX_TEXT_FILES, remapAssets, TEXT_MIME } from "../shared/attachments";
import { countLines, decodeText, withFiles } from "../shared/files";
import { COLORS_KEY, FOLDERS_KEY, MAX_SAVED_COLORS, parseColors, parseFolders, type Folders } from "../shared/folders";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addTurn,
  newCanvas,
  patchMessage,
  recoverCanvas,
  requestHistory,
  withoutImages,
  ancestorPath,
  copyBranch,
  detachBranch,
} from "../shared/graph";
import { CHATGPT_PLAN, LEGACY_MODEL, LEGACY_PROVIDER, type ModelInfo } from "../shared/models";
import type {
  Canvas,
  ChatMessage,
  Completion,
  ImageRef,
  TextFileRef,
} from "../shared/types";
import { createRepository, type Repository } from "./storage";
import { api } from "./api";
import { downloadCanvas } from "./exportCanvas";
import { readExport } from "./importCanvas";
import type { PageSelection } from "./DocumentPages";
import {
  documentPage,
  isImageFile,
  MAX_IMAGES,
  prepareImage,
} from "./images";

// `models` lists the connected providers' models; it decides which answers may see images.
export function useWorkspace(models: ModelInfo[]) {
  const modelList = useRef(models);
  modelList.current = models;
  const [canvases, setCanvases] = useState<Canvas[]>([]);
  const [activeId, setActiveId] = useState<string>("");
  const [preferences, setPreferences] = useState<Record<string, string>>({});
  // Read synchronously by changes that build on the latest preference value.
  const preferencesRef = useRef<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [saveStates, setSaveStates] = useState<Record<string, { saving: boolean; error?: string }>>({});
  const [preferenceError, setPreferenceError] = useState("");
  const preferenceSequence = useRef(0);
  const [notice, setNotice] = useState("");
  const [preparationProgress, setPreparationProgress] = useState("");
  const [preparingId, setPreparingId] = useState<string>();
  const [pageSelection, setPageSelection] = useState<PageSelection>();
  const [chatRequest, setChatRequest] = useState<{ canvasId: string; sequence: number }>();
  const preparation = useRef<{ canvasId: string; controller: AbortController } | undefined>(undefined);
  const data = useRef<Canvas[]>([]);
  const repository = useRef<Repository | null>(null);
  const busy = useRef(new Set<string>());
  const groupSelection = useRef(new Set<string>());
  const setGroupSelection = useCallback((canvasId: string, active: boolean) => {
    if (active) groupSelection.current.add(canvasId); else groupSelection.current.delete(canvasId);
  }, []);
  const controllers = useRef(new Map<string, AbortController>());
  const unloading = useRef(false);
  const previewRequests = useRef(new AbortController());
  const saveSequence = useRef(0);
  const latestSave = useRef(new Map<string, number>());
  const imageUrls = useRef(new Map<string, Promise<string | undefined>>());

  useEffect(() => {
    const repo = createRepository();
    repository.current = repo;
    let disposed = false;
    (async () => {
      try {
        const stored = await repo.load();
        const restored = stored.canvases.map(recoverCanvas);
        if (!restored.length) restored.push(newCanvas());
        // Persist interrupted status before allowing any interaction.
        for (const canvas of restored) await repo.save(canvas);
        if (disposed) return;
        data.current = restored;
        setCanvases(restored);
        setActiveId(
          restored.some((c) => c.id === stored.activeId)
            ? stored.activeId!
            : restored[0].id,
        );
        preferencesRef.current = stored.preferences;
        setPreferences(stored.preferences);
        setLoading(false);
      } catch (error) {
        if (!disposed) {
          setLoadError(
            (error as Error).message || "Could not open local storage.",
          );
          setLoading(false);
        }
      }
    })();
    const abortAll = () => {
      unloading.current = true;
      previewRequests.current.abort();
      preparation.current?.controller.abort();
      for (const c of controllers.current.values()) c.abort();
    };
    window.addEventListener("beforeunload", abortAll);
    window.addEventListener("pagehide", abortAll);
    const urls = imageUrls.current;
    return () => {
      disposed = true;
      abortAll();
      for (const url of urls.values())
        void url.then((u) => u && URL.revokeObjectURL(u)).catch(() => {});
      window.removeEventListener("beforeunload", abortAll);
      window.removeEventListener("pagehide", abortAll);
      void repo.close();
    };
  }, []);

  async function commit(next: Canvas) {
    data.current = data.current.some((c) => c.id === next.id)
      ? data.current.map((c) => (c.id === next.id ? next : c))
      : [...data.current, next];
    setCanvases(data.current);
    const sequence = ++saveSequence.current;
    latestSave.current.set(next.id, sequence);
    const publish = (state: { saving: boolean; error?: string }) => {
      if (latestSave.current.get(next.id) === sequence)
        setSaveStates((previous) => ({ ...previous, [next.id]: state }));
    };
    publish({ saving: true });
    try {
      await repository.current!.save(next);
      publish({ saving: false });
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : "";
      publish({
        saving: false,
        error: `Changes could not be saved to this Mac.${detail ? ` ${detail}` : ""}`,
      });
      return false;
    }
  }

  function update(id: string, transform: (canvas: Canvas) => Canvas) {
    const current = data.current.find((c) => c.id === id);
    if (!current) return Promise.resolve(false);
    const next = transform(current);
    return next === current ? Promise.resolve(true) : commit(next);
  }

  const loadImage = useCallback((id: string) => {
    if (unloading.current) return Promise.resolve(undefined);
    let url = imageUrls.current.get(id);
    if (!url) {
      url = repository
        .current!.getImage(id, previewRequests.current.signal)
        .then((blob) => (blob ? URL.createObjectURL(blob) : undefined));
      url.catch(() => imageUrls.current.delete(id));
      imageUrls.current.set(id, url);
    }
    return url;
  }, []);

  const assetIds = (images: ImageRef[] = []) =>
    images.flatMap((image) => {
      const source = documentPage(image);
      return source ? [image.id, source.id] : [image.id];
    });

  // Delete attachment blobs that no prompt or draft refers to anymore.
  function releaseImages(ids: string[]) {
    const used = new Set(
      data.current.flatMap((c) => [
        ...assetIds(c.draftImages),
        ...(c.draftFiles ?? []).map((file) => file.id),
        ...c.messages.flatMap((m) => [...assetIds(m.images), ...(m.files ?? []).map((file) => file.id)]),
      ]),
    );
    for (const id of ids) {
      if (used.has(id)) continue;
      void imageUrls.current
        .get(id)
        ?.then((u) => u && URL.revokeObjectURL(u))
        .catch(() => {});
      imageUrls.current.delete(id);
      void repository.current!.deleteImage(id).catch(() => {});
    }
  }

  async function run(canvasId: string, answerId: string) {
    // The stored pending record is recovered by the next page. An unloading page
    // must neither start inference after its save nor overwrite that recovery.
    if (unloading.current) {
      busy.current.delete(canvasId);
      return;
    }
    const controller = new AbortController();
    controllers.current.set(canvasId, controller);
    try {
      const canvas = data.current.find((c) => c.id === canvasId)!;
      const answer = canvas.messages.find((m) => m.id === answerId);
      // Answers from before model choice were written by DeepSeek Flash.
      const provider = answer?.provider ?? LEGACY_PROVIDER;
      const model = answer?.model ?? LEGACY_MODEL;
      // Models the catalog doesn't describe may see images; the provider decides.
      const vision = provider === CHATGPT_PLAN || (modelList.current.find((m) => m.provider === provider && m.id === model)?.vision ?? true);
      const history = requestHistory(canvas, answerId);
      // Files travel as text inside their prompt, so every model can read them.
      const readFile = async (file: TextFileRef) => {
        const blob = await repository.current!.getImage(file.id, controller.signal);
        if (!blob) throw new Error(`${file.name} is missing from local storage. Attach it again in a new prompt.`);
        return { name: file.name, text: await blob.text() };
      };
      const messages: ChatMessage[] = await Promise.all(
        (vision ? history : withoutImages(history)).map(
          async ({ images, files, ...m }) => ({
            ...m,
            ...(files?.length ? { content: withFiles(m.content, await Promise.all(files.map(readFile))) } : {}),
            ...(images ? { attachmentIds: images.map(image => image.id) } : {}),
          }),
        ),
      );
      if (controller.signal.aborted || unloading.current) return;
      setChatRequest((previous) => ({ canvasId, sequence: (previous?.sequence ?? 0) + 1 }));
      const response = await api<Completion>("/api/chat", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          canvasId,
          requestId: answerId,
          provider,
          model,
          profileId: answer?.profileId,
          ...(answer?.reasoning ? { reasoning: answer.reasoning } : {}),
          messages,
        }),
      });
      if (unloading.current) return;
      await update(canvasId, (c) => {
        const completed = patchMessage(c, answerId, {
          status: "complete",
          content: response.content,
          truncated: response.finishReason === "length",
          usage: response.usage,
          completedAt: Date.now(),
          error: undefined,
          errorCode: undefined,
        });
        // Don't replace a parent the user deliberately selected during generation.
        // Chat mode always follows the answer, as a chat continues from it.
        const promptId = c.messages.find((m) => m.id === answerId)?.parentId;
        const chatting = c.readerExpanded && c.readingPanelOpen !== false;
        return c.selectedId === promptId && (!c.draft || chatting) && !groupSelection.current.has(canvasId)
          ? { ...completed, selectedId: answerId, draftParentId: answerId }
          : completed;
      });
    } catch (error) {
      if (!unloading.current)
        await update(canvasId, (c) =>
          patchMessage(c, answerId, {
            status: controller.signal.aborted ? "interrupted" : "error",
            error: (error as Error).message,
            errorCode: (error as { code?: string }).code,
          }),
        );
    } finally {
      controllers.current.delete(canvasId);
      busy.current.delete(canvasId);
    }
  }

  async function send(
    canvasId: string,
    text: string,
    parentId: string | null,
    model: ModelInfo,
    onTurn: (ids: string[], first: boolean) => void,
    geometry?: Record<string, import("../shared/graph").PlacementRect>,
    // The thinking level for this answer; absent leaves it to the provider.
    reasoning?: string,
  ) {
    if (busy.current.has(canvasId) || preparation.current?.canvasId === canvasId) return;
    busy.current.add(canvasId);
    setNotice("");
    try {
      const current = data.current.find((c) => c.id === canvasId)!;
      if (current.draftImages?.length && !model.vision)
        throw new Error(`${model.label} can’t see images or document pages. Choose a model that can.`);
      const turn = addTurn(current, text, parentId, {
        images: current.draftImages,
        files: current.draftFiles,
        editOf: current.editingId ?? undefined,
        model: model.id,
        provider: model.provider,
        profileId: model.profileId,
        reasoning: reasoning && model.efforts?.includes(reasoning) ? reasoning : undefined,
        geometry,
      });
      const saved = commit(turn.canvas);
      onTurn(turn.canvas.messages.slice(-2).map((message) => message.id), !current.messages.length);
      if (!(await saved)) {
        await update(canvasId, (c) =>
          patchMessage(c, turn.answerId, {
            status: "error",
            error:
              "The prompt could not be saved. No inference request was sent. Retry after fixing local storage.",
          }),
        );
        busy.current.delete(canvasId);
        return;
      }
      await run(canvasId, turn.answerId);
    } catch (error) {
      busy.current.delete(canvasId);
      setNotice((error as Error).message);
    }
  }

  async function retry(canvasId: string, answerId: string, route?: ModelInfo) {
    const current = data.current.find((c) => c.id === canvasId);
    const answer = current?.messages.find((m) => m.id === answerId);
    if (
      !current ||
      !answer ||
      !["error", "interrupted"].includes(answer.status) ||
      (route && answer.provider !== CHATGPT_PLAN) ||
      busy.current.has(canvasId) ||
      preparation.current?.canvasId === canvasId ||
      current.messages.some((m) => m.status === "pending")
    )
      return;
    busy.current.add(canvasId);
    if (
      !(await update(canvasId, (c) =>
        patchMessage(c, answerId, {
          status: "pending", error: undefined, errorCode: undefined,
          ...(route ? {
            provider: route.provider, model: route.id, profileId: route.profileId,
            // A level the new route doesn't offer falls back to its default.
            reasoning: answer.reasoning && route.efforts?.includes(answer.reasoning) ? answer.reasoning : undefined,
          } : {}),
        }),
      ))
    ) {
      await update(canvasId, (c) =>
        patchMessage(c, answerId, {
          status: "error",
          provider: answer.provider, model: answer.model, profileId: answer.profileId, reasoning: answer.reasoning,
          error:
            "Local storage is still unavailable. No inference request was sent.",
        }),
      );
      busy.current.delete(canvasId);
      return;
    }
    await run(canvasId, answerId);
  }

  function cancelPreparation() {
    preparation.current?.controller.abort();
  }
  function selectCanvas(id: string) {
    if (preparation.current?.canvasId !== id) cancelPreparation();
    setActiveId(id);
    setNotice("");
    const sequence = ++preferenceSequence.current;
    setPreferenceError("");
    void repository.current!.setActive(id).catch(() => {
      if (preferenceSequence.current === sequence)
        setPreferenceError("Could not remember which canvas to reopen.");
    });
  }
  function createCanvas() {
    const canvas = newCanvas();
    void commit(canvas);
    selectCanvas(canvas.id);
  }
  // Leaving edit mode discards the pre-filled edit, never the original prompt.
  function withoutEdit(c: Canvas): Canvas {
    return c.editingId
      ? { ...c, editingId: null, draft: "", draftImages: [], draftFiles: [] }
      : c;
  }
  async function changeDraft(
    canvasId: string,
    transform: (c: Canvas) => Canvas,
  ) {
    const current = data.current.find((c) => c.id === canvasId);
    if (!current) return;
    const next = transform(current);
    if (current.editingId !== next.editingId && preparation.current?.canvasId === canvasId)
      cancelPreparation();
    if (await commit(next)) releaseImages([...assetIds(current.draftImages), ...(current.draftFiles ?? []).map((file) => file.id)]);
  }
  function selectMessage(canvasId: string, messageId: string) {
    void changeDraft(canvasId, (c) => {
      if (c.messages.find((m) => m.id === messageId)?.status !== "complete")
        return c;
      return {
        ...(c.editingId === messageId ? c : withoutEdit(c)),
        selectedId: messageId,
        draftParentId: messageId,
      };
    });
  }
  function deselect(canvasId: string) {
    void changeDraft(canvasId, (c) => ({
      ...withoutEdit(c),
      selectedId: null,
      draftParentId: null,
    }));
  }
  function startEdit(canvasId: string, promptId: string) {
    void changeDraft(canvasId, (c) => {
      const prompt = c.messages.find((m) => m.id === promptId);
      if (prompt?.role !== "user") return c;
      return {
        ...c,
        editingId: prompt.id,
        selectedId: prompt.id,
        draftParentId: prompt.id,
        draft: prompt.content,
        draftImages: prompt.images ?? [],
        draftFiles: prompt.files ?? [],
      };
    });
  }
  function cancelEdit(canvasId: string) {
    void changeDraft(canvasId, withoutEdit);
  }
  // Code and text files: read as UTF-8, kept with the other attachments and
  // sent inline. Returns false when nothing else should be attached.
  async function attachText(canvasId: string, files: File[]) {
    const current = data.current.find((c) => c.id === canvasId)!;
    const room = MAX_TEXT_FILES - (current.draftFiles?.length ?? 0);
    if (files.length > room) {
      setNotice(room > 0 ? `A prompt can carry ${MAX_TEXT_FILES} files. There is room for ${room} more.` : `A prompt can carry at most ${MAX_TEXT_FILES} files.`);
      return false;
    }
    const large = files.find((file) => file.size > MAX_TEXT_FILE_BYTES);
    if (large) {
      setNotice(`${large.name} is larger than 1 MiB. Attach a smaller file, or paste the part you need.`);
      return false;
    }
    const refs: TextFileRef[] = [];
    const assets: { id: string; blob: Blob }[] = [];
    const unreadable: string[] = [];
    for (const file of files) {
      const text = decodeText(await file.arrayBuffer());
      if (text === undefined) { unreadable.push(file.name); continue; }
      const blob = new Blob([text], { type: TEXT_MIME });
      const id = crypto.randomUUID();
      refs.push({ id, name: file.name.slice(0, 200), bytes: blob.size, lines: countLines(text) });
      assets.push({ id, blob });
    }
    if (unreadable.length)
      setNotice(`${unreadable.join(", ")} ${unreadable.length === 1 ? "isn’t" : "aren’t"} text Canvas can read. Attach images, PDFs, DOCX, or code and text files.`);
    if (!assets.length) return true;
    try {
      await repository.current!.putAttachments(assets);
    } catch {
      setNotice("Files couldn’t be saved. Free disk space or check Canvas folder permissions and attach them again.");
      return false;
    }
    if (!(await update(canvasId, (c) => ({ ...c, draftFiles: [...(c.draftFiles ?? []), ...refs] })))) {
      setNotice("The attachment draft couldn’t be saved. Free disk space or check Canvas folder permissions and choose Try saving again before reloading.");
      return false;
    }
    return true;
  }
  async function attachFiles(canvasId: string, files: File[], vision: boolean) {
    if (!files.length || preparation.current) return;
    setNotice("");
    const current = data.current.find((c) => c.id === canvasId);
    if (!current) return;
    const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    const isDocx = (file: File) => file.type === docxMime || /\.docx$/i.test(file.name);
    const isDocument = (file: File) => isDocx(file) || file.type === "application/pdf" || /\.pdf$/i.test(file.name);
    // Anything that isn't an image or document is tried as text.
    const texts = files.filter((file) => !isDocument(file) && !isImageFile(file));
    if (texts.length && !(await attachText(canvasId, texts))) return;
    files = files.filter((file) => !texts.includes(file));
    if (!files.length) return;
    if (!vision) {
      setNotice("Choose a model that sees images to attach images or document pages.");
      return;
    }
    const documents = files.filter(isDocument);
    const images = files.filter((file) => !documents.includes(file) && isImageFile(file));
    if (documents.length > 1) {
      setNotice("Attach one PDF or DOCX at a time.");
      return;
    }
    const file = documents[0];
    const maxBytes = MAX_IMAGE_BYTES;
    if (images.some((entry) => entry.size > maxBytes)) {
      setNotice("Each image must be 64 MiB or smaller. Try a smaller copy.");
      return;
    }
    const contextId = current.editingId ? current.messages.find(m => m.id === current.editingId)?.parentId ?? null : current.draftParentId;
    const previous = [...ancestorPath(current, contextId).flatMap(m => m.images ?? []), ...(current.draftImages ?? [])];
    const room = MAX_IMAGES - previous.length;
    if (file && images.length >= room) {
      setNotice("Free at least one image slot before attaching this document, or attach it separately.");
      return;
    }
    if (images.length > room) { setNotice(`This branch has room for ${Math.max(0, room)} more images or document pages.`); return; }
    if (!file && (!room || !images.length)) return;

    const controller = new AbortController();
    const { signal } = controller;
    preparation.current = { canvasId, controller };
    setPreparingId(canvasId);
    setPreparationProgress("Preparing attachments…");
    const previousSizes: number[] = [];
    const refs: ImageRef[] = [];
    const assets: { id: string; blob: Blob }[] = [];
    const add = ({ blob, ...ref }: Awaited<ReturnType<typeof prepareImage>>, source?: Pick<ImageRef, "pdf" | "docx">) => {
      const id = crypto.randomUUID();
      checkImageBudget([...previousSizes, ...assets.filter(asset => refs.some(ref => ref.id === asset.id)).map(asset => asset.blob.size), blob.size]);
      refs.push({ ...ref, id, bytes: blob.size, ...source });
      assets.push({ id, blob });
    };
    try {
    for (const image of previous) {
      if (image.bytes !== undefined) previousSizes.push(image.bytes);
      else {
        const response = await fetch(`/api/workspace/attachments/${encodeURIComponent(image.id)}`, { method: "HEAD", signal });
        if (!response.ok) { setNotice("An ancestor attachment is missing. Attach it again before continuing."); preparation.current = undefined; setPreparingId(undefined); return; }
        previousSizes.push(Number(response.headers.get("Content-Length")));
      }
    }
      for (const image of images.slice(0, room)) {
        signal.throwIfAborted();
        try {
          const prepared = await prepareImage(image);
          add(prepared);
        } catch (error) {
          throw error;
        }
      }
      if (file) {
        const slots = room - refs.length;
        const kind = isDocx(file) ? "docx" : "pdf";
        const render = kind === "docx"
          ? (await import("./docx")).renderDocx
          : (await import("./pdf")).renderPdf;
        let forcePicker = false;
        const choosePages = (total: number): Promise<number[]> => {
          signal.throwIfAborted();
          if (!forcePicker && total <= slots) return Promise.resolve(Array.from({ length: total }, (_, i) => i + 1));
          return new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            setPageSelection({
              name: file.name,
              kind,
              total,
              slots,
              choose: (pages) => {
                signal.removeEventListener("abort", abort);
                setPageSelection(undefined);
                resolve(pages);
              },
            });
          });
        };
        let pages: Awaited<ReturnType<typeof render>>;
        while (true) {
          const sizes: number[] = [];
          try {
            pages = await render(file, signal, choosePages, blob => {
              checkImageBudget([...previousSizes, ...refs.map(ref => ref.bytes ?? 0), ...sizes, blob.size]);
              sizes.push(blob.size);
              setPreparationProgress(`Preparing ${file.name}: ${sizes.length} pages…`);
            });
            break;
          } catch (error) {
            if (signal.aborted || !(error instanceof AttachmentLimitError)) throw error;
            forcePicker = true;
            setNotice(`${error.message} Choose a smaller page range.`);
          }
        }
        const id = crypto.randomUUID();
        assets.push({ id, blob: file.slice(0, file.size, kind === "docx" ? docxMime : "application/pdf") });
        for (const { page, ...prepared } of pages)
          add(prepared, { [kind]: { id, name: file.name, page } });
      }
      signal.throwIfAborted();
      if (!assets.length) return;
      try {
        await repository.current!.putAttachments(assets);
      } catch {
        throw new Error("Attachments couldn’t be saved. Free disk space or check Canvas folder permissions and attach the files again.");
      }
      if (signal.aborted) {
        releaseImages(assets.map(({ id }) => id));
        return;
      }
      if (!(await update(canvasId, (c) => ({
        ...c,
        draftImages: [...(c.draftImages ?? []), ...refs],
      }))) && !signal.aborted)
        setNotice("The attachment draft couldn’t be saved. Free disk space or check Canvas folder permissions and choose Try saving again before reloading.");
    } catch (error) {
      if (!signal.aborted) setNotice((error as Error).message);
    } finally {
      preparation.current = undefined;
      setPreparingId(undefined);
      setPageSelection(undefined);
    }
  }
  function removeDraftFile(canvasId: string, id: string) {
    void changeDraft(canvasId, (c) => ({ ...c, draftFiles: (c.draftFiles ?? []).filter((file) => file.id !== id) }));
  }
  function removeDraftImage(canvasId: string, id: string) {
    void changeDraft(canvasId, (c) => ({
      ...c,
      draftImages: (c.draftImages ?? []).filter((ref) => ref.id !== id && documentPage(ref)?.id !== id),
    }));
  }
  async function exportCanvas(canvasId: string) {
    const canvas = data.current.find((c) => c.id === canvasId);
    if (canvas) await downloadCanvas(structuredClone(canvas), repository.current!.getImage);
  }
  function retrySave() {
    const current = data.current.find((canvas) => canvas.id === activeId);
    if (current) return commit(current);
  }
  const setPreference = useCallback((key: string, value: string) => {
    preferencesRef.current = { ...preferencesRef.current, [key]: value };
    setPreferences(preferencesRef.current);
    void repository.current?.setPreference(key, value).catch(() => setPreferenceError("Could not save workspace preferences. Try again."));
  }, []);

  // Deletes a canvas file; its folder placement goes with it.
  async function deleteCanvas(id: string) {
    const canvas = data.current.find((c) => c.id === id);
    if (!canvas) return;
    if (busy.current.has(id) || canvas.messages.some((m) => m.status === "pending")) {
      setNotice("Wait for the answer on this canvas to finish, then delete it.");
      return;
    }
    if (preparation.current?.canvasId === id) cancelPreparation();
    try {
      await repository.current!.deleteCanvas(id);
    } catch (error) {
      setNotice((error as Error).message || "This canvas couldn’t be deleted. Check the Canvas folder permissions, then try again.");
      return;
    }
    latestSave.current.delete(id);
    data.current = data.current.filter((c) => c.id !== id);
    setCanvases(data.current);
    changeFolders((f) => {
      if (!(id in f.placement)) return f;
      const { [id]: _removed, ...placement } = f.placement;
      return { ...f, placement };
    });
    if (id !== activeId) return;
    const next = [...data.current].sort((a, b) => b.createdAt - a.createdAt)[0];
    if (next) selectCanvas(next.id); else createCanvas();
  }
  function renameCanvas(id: string, title: string) {
    const name = title.replace(/\s+/g, " ").trim().slice(0, 120);
    if (name) void update(id, (c) => (c.title === name ? c : { ...c, title: name, updatedAt: Date.now() }));
  }
  // Folders are a workspace preference; canvases outside one sit in "Your space".
  function changeFolders(change: (folders: Folders) => Folders) {
    const current = parseFolders(preferencesRef.current[FOLDERS_KEY]);
    const next = change(current);
    if (next !== current) setPreference(FOLDERS_KEY, JSON.stringify(next));
  }
  function createFolder(name = "New folder") {
    const id = crypto.randomUUID();
    changeFolders((f) => (f.folders.length >= 100 ? f : { ...f, folders: [...f.folders, { id, name }] }));
    return id;
  }
  function renameFolder(id: string, name: string) {
    const clean = name.replace(/\s+/g, " ").trim().slice(0, 60);
    if (clean) changeFolders((f) => ({ ...f, folders: f.folders.map((folder) => (folder.id === id ? { ...folder, name: clean } : folder)) }));
  }
  // Removes the folder only; its canvases move back to "Your space".
  function deleteFolder(id: string) {
    changeFolders((f) => ({
      folders: f.folders.filter((folder) => folder.id !== id),
      placement: Object.fromEntries(Object.entries(f.placement).filter(([, folder]) => folder !== id)),
      collapsed: f.collapsed.filter((folder) => folder !== id),
    }));
  }
  function moveCanvas(canvasId: string, folderId: string | null) {
    changeFolders((f) => {
      const { [canvasId]: _previous, ...placement } = f.placement;
      return { ...f, placement: folderId && f.folders.some((folder) => folder.id === folderId) ? { ...placement, [canvasId]: folderId } : placement };
    });
  }
  function toggleFolder(id: string) {
    changeFolders((f) => ({ ...f, collapsed: f.collapsed.includes(id) ? f.collapsed.filter((folder) => folder !== id) : [...f.collapsed, id] }));
  }
  // Custom bubble colors, newest first.
  function saveColor(hex: string) {
    const color = hex.toLowerCase();
    const colors = parseColors(preferencesRef.current[COLORS_KEY]);
    setPreference(COLORS_KEY, JSON.stringify([color, ...colors.filter((c) => c !== color)].slice(0, MAX_SAVED_COLORS)));
  }
  // Opens a Canvas JSON export as a new canvas.
  async function importFile(file: File) {
    setNotice("");
    try {
      const { canvas, entries } = await readExport(file);
      const { id, assets } = await repository.current!.importExport(canvas, entries);
      const imported = recoverCanvas({ ...remapAssets(canvas, assets), id });
      if (!(await commit(imported))) throw new Error("The imported canvas couldn’t be saved. Free disk space or check Canvas folder permissions.");
      selectCanvas(id);
    } catch (error) {
      setNotice((error as Error).message);
    }
  }
  // "Continue here" cuts the branch loose on this canvas; "New chat" copies it to
  // a new canvas in the same folder. Either way context starts at its top bubble.
  async function branchOff(canvasId: string, messageId: string, mode: "detach" | "copy") {
    const current = data.current.find((c) => c.id === canvasId);
    if (!current) return;
    setNotice("");
    try {
      if (mode === "detach") {
        await update(canvasId, (c) => detachBranch(c, messageId));
        return;
      }
      const copy = copyBranch(current, messageId);
      // Open it right away, as a new canvas does; the sidebar reports a failed save.
      const saved = commit(copy);
      const folder = parseFolders(preferencesRef.current[FOLDERS_KEY]).placement[canvasId];
      if (folder) moveCanvas(copy.id, folder);
      selectCanvas(copy.id);
      if (!(await saved)) setNotice("The new canvas couldn’t be saved. Free disk space or check Canvas folder permissions, then choose Try saving again.");
      return copy;
    } catch (error) {
      setNotice((error as Error).message);
    }
  }

  return {
    folders: parseFolders(preferences[FOLDERS_KEY]),
    savedColors: parseColors(preferences[COLORS_KEY]),
    deleteCanvas,
    renameCanvas,
    createFolder,
    renameFolder,
    deleteFolder,
    moveCanvas,
    toggleFolder,
    saveColor,
    importFile,
    branchOff,
    preferences,
    setPreference,
    canvases,
    active: canvases.find((c) => c.id === activeId),
    loading,
    loadError,
    saveState: saveStates[activeId],
    preferenceError,
    notice,
    update,
    send,
    retry,
    createCanvas,
    selectCanvas,
    selectMessage,
    setGroupSelection,
    deselect,
    startEdit,
    cancelEdit,
    attachFiles,
    preparationProgress,
    preparing: activeId === preparingId,
    pageSelection: activeId === preparingId ? pageSelection : undefined,
    cancelPreparation,
    chatRequest,
    exportCanvas,
    removeDraftImage,
    removeDraftFile,
    loadImage,
    retrySave,
    dismissNotice: () => setNotice(""),
  };
}
