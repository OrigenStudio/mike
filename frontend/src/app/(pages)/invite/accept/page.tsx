"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { acceptInvitation } from "@/app/lib/orgApi";

function AcceptInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token");
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!token) {
      setState("error");
      setMessage("Missing invitation token.");
      return;
    }
    acceptInvitation(token)
      .then(() => {
        setState("ok");
        setMessage("You've joined the organization.");
        setTimeout(() => router.push("/organization"), 1500);
      })
      .catch((e: unknown) => {
        setState("error");
        setMessage(e instanceof Error ? e.message : "Could not accept invitation.");
      });
  }, [token, router]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {state === "loading" && (
        <>
          <Loader2 className="h-8 w-8 animate-spin text-gray-400" />
          <p className="text-gray-600">Accepting your invitation…</p>
        </>
      )}
      {state === "ok" && (
        <>
          <CheckCircle2 className="h-10 w-10 text-green-600" />
          <p className="text-gray-800">{message}</p>
        </>
      )}
      {state === "error" && (
        <>
          <XCircle className="h-10 w-10 text-red-500" />
          <p className="text-gray-800">{message}</p>
          <button
            onClick={() => router.push("/organization")}
            className="mt-2 text-sm text-blue-600 hover:underline"
          >
            Go to organizations
          </button>
        </>
      )}
    </div>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
        </div>
      }
    >
      <AcceptInner />
    </Suspense>
  );
}
