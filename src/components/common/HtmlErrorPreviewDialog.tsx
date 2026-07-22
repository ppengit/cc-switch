import { X } from "lucide-react";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface HtmlErrorPreviewDialogProps {
  document: string | null;
  title: string;
  description: string;
  frameTitle: string;
  closeLabel: string;
  onOpenChange: (open: boolean) => void;
}

export function HtmlErrorPreviewDialog({
  document,
  title,
  description,
  frameTitle,
  closeLabel,
  onOpenChange,
}: HtmlErrorPreviewDialogProps) {
  return (
    <Dialog open={document !== null} onOpenChange={onOpenChange}>
      {document !== null ? (
        <DialogContent
          zIndex="top"
          closeOnInteractOutside
          className="h-[min(52rem,calc(100vh-2rem))] w-[calc(100vw-2rem)] max-w-[min(1280px,calc(100vw-2rem))] overflow-hidden p-0"
        >
          <DialogClose
            className="absolute right-4 top-4 z-10 rounded-md p-1.5 text-muted-foreground opacity-70 transition hover:bg-muted hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring"
            aria-label={closeLabel}
          >
            <X className="h-4 w-4" />
          </DialogClose>
          <DialogHeader className="pr-12">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <iframe
            srcDoc={document}
            sandbox=""
            referrerPolicy="no-referrer"
            className="min-h-0 flex-1 w-full border-0 bg-white"
            title={frameTitle}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
