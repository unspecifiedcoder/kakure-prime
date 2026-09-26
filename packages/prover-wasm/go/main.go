// Command prover-wasm compiles the Sunspot/gnark Groth16 prover to WebAssembly
// (GOOS=js GOARCH=wasm) and exposes a single JS-callable function:
//
//	globalThis.kakureProve(circuitAcirJson, witnessGz, ccsBytes, pkBytes) -> Promise<{proof, pw}>
//
// It mirrors exactly what Sunspot's `sunspot prove` CLI subcommand does
// (~/sunspot/go/cmd/prove.go): load the ACIR, deserialize the CCS and proving
// key, build the witness assignment from the Noir witness.gz, run
// groth16.Prove, then serialize the raw (uncompressed) proof and the public
// witness in Sunspot's own on-wire byte layout -- the same bytes
// `packages/prover/src/decode.ts` parses on the Node/CLI path. `proof` and
// `pw` are returned as `Uint8Array`s (via `js.CopyBytesToJS`).
//
// This file has no build tag -- it is only ever built with GOOS=js
// GOARCH=wasm (see the package README for the exact build command); a normal
// `go build` for the host OS fails because `syscall/js` only exists on js/wasm.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"syscall/js"

	"github.com/reilabs/sunspot/go/acir"
	"github.com/reilabs/sunspot/go/bn254"

	"github.com/consensys/gnark-crypto/ecc"
	ecc_bn254 "github.com/consensys/gnark-crypto/ecc/bn254"
	"github.com/consensys/gnark/backend/groth16"
	"github.com/consensys/gnark/constraint"
)

type acirT = acir.ACIR[*bn254.BN254Field, constraint.U64]

type preparedCircuit struct {
	acir acirT
	ccs  constraint.ConstraintSystem
	pk   groth16.ProvingKey
}

// preparedCircuits keeps the expensive, immutable circuit/key deserialization alive for the
// lifetime of the worker. A proving key can be tens of megabytes; parsing it for every proof was
// needless first-order latency and allocation pressure.
var preparedCircuits = make(map[string]*preparedCircuit)

// jsBytes copies a JS Uint8Array argument into a Go []byte.
func jsBytes(v js.Value) []byte {
	length := v.Get("length").Int()
	buf := make([]byte, length)
	js.CopyBytesToGo(buf, v)
	return buf
}

// jsErrorObject builds a plain JS Error with the given message.
func jsErrorObject(format string, args ...any) js.Value {
	errCtor := js.Global().Get("Error")
	return errCtor.New(fmt.Sprintf(format, args...))
}

// prove implements the JS-visible kakureProve(acirJson, witnessGz, ccsBytes, pkBytes).
// It returns a JS Promise that resolves to {proof: Uint8Array, pw: Uint8Array}
// or rejects with an Error carrying a descriptive message.
func prove(this js.Value, args []js.Value) any {
	handler := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]

		go func() {
			proofBytes, pwBytes, err := doProve(args)
			if err != nil {
				reject.Invoke(jsErrorObject("kakureProve: %v", err))
				return
			}
			proofArr := js.Global().Get("Uint8Array").New(len(proofBytes))
			js.CopyBytesToJS(proofArr, proofBytes)
			pwArr := js.Global().Get("Uint8Array").New(len(pwBytes))
			js.CopyBytesToJS(pwArr, pwBytes)
			result := js.Global().Get("Object").New()
			result.Set("proof", proofArr)
			result.Set("pw", pwArr)
			resolve.Invoke(result)
		}()
		return nil
	})
	promiseCtor := js.Global().Get("Promise")
	return promiseCtor.New(handler)
}

func doProve(args []js.Value) (proofBytes []byte, pwBytes []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("panic: %v", r)
		}
	}()

	if len(args) != 4 {
		return nil, nil, fmt.Errorf("expected 4 arguments (acirJson, witnessGz, ccsBytes, pkBytes), got %d", len(args))
	}
	acirJSON := args[0].String()
	witnessBytes := jsBytes(args[1])
	ccsBytes := jsBytes(args[2])
	pkBytes := jsBytes(args[3])

	// ACIR's UnmarshalJSON is exported (satisfies json.Unmarshaler), so we can
	// decode straight from the in-memory JSON bytes without touching
	// acir.LoadACIR's file-path-only entry point.
	var loadedAcir acirT
	if err := json.Unmarshal([]byte(acirJSON), &loadedAcir); err != nil {
		return nil, nil, fmt.Errorf("load ACIR: %w", err)
	}

	ccs := groth16.NewCS(ecc.BN254)
	if _, err := ccs.ReadFrom(bytes.NewReader(ccsBytes)); err != nil {
		return nil, nil, fmt.Errorf("read CCS: %w", err)
	}

	pk := groth16.NewProvingKey(ecc.BN254)
	if _, err := pk.ReadFrom(bytes.NewReader(pkBytes)); err != nil {
		return nil, nil, fmt.Errorf("read proving key: %w", err)
	}

	return proveWithPrepared(&preparedCircuit{acir: loadedAcir, ccs: ccs, pk: pk}, witnessBytes)
}

func prepareCircuit(this js.Value, args []js.Value) any {
	return promise(func() (js.Value, error) {
		if len(args) != 4 {
			return js.Undefined(), fmt.Errorf("expected 4 arguments (id, acirJson, ccsBytes, pkBytes), got %d", len(args))
		}
		id := args[0].String()
		if id == "" {
			return js.Undefined(), fmt.Errorf("circuit id must not be empty")
		}
		var loadedAcir acirT
		if err := json.Unmarshal([]byte(args[1].String()), &loadedAcir); err != nil {
			return js.Undefined(), fmt.Errorf("load ACIR: %w", err)
		}
		ccs := groth16.NewCS(ecc.BN254)
		if _, err := ccs.ReadFrom(bytes.NewReader(jsBytes(args[2]))); err != nil {
			return js.Undefined(), fmt.Errorf("read CCS: %w", err)
		}
		pk := groth16.NewProvingKey(ecc.BN254)
		if _, err := pk.ReadFrom(bytes.NewReader(jsBytes(args[3]))); err != nil {
			return js.Undefined(), fmt.Errorf("read proving key: %w", err)
		}
		preparedCircuits[id] = &preparedCircuit{acir: loadedAcir, ccs: ccs, pk: pk}
		return js.Undefined(), nil
	})
}

func provePrepared(this js.Value, args []js.Value) any {
	return promise(func() (js.Value, error) {
		if len(args) != 2 {
			return js.Undefined(), fmt.Errorf("expected 2 arguments (id, witnessGz), got %d", len(args))
		}
		id := args[0].String()
		prepared, ok := preparedCircuits[id]
		if !ok {
			return js.Undefined(), fmt.Errorf("circuit %q has not been prepared", id)
		}
		proofBytes, pwBytes, err := proveWithPrepared(prepared, jsBytes(args[1]))
		if err != nil {
			return js.Undefined(), err
		}
		return proofResult(proofBytes, pwBytes), nil
	})
}

func proveWithPrepared(prepared *preparedCircuit, witnessBytes []byte) ([]byte, []byte, error) {
	witness, err := getWitnessFromBytes(&prepared.acir, witnessBytes, ecc_bn254.ID.ScalarField())
	if err != nil {
		return nil, nil, fmt.Errorf("get witness: %w", err)
	}

	proof, err := groth16.Prove(prepared.ccs, prepared.pk, witness)
	if err != nil {
		return nil, nil, fmt.Errorf("groth16 prove: %w", err)
	}

	var proofBuf bytes.Buffer
	if _, err := proof.WriteRawTo(&proofBuf); err != nil {
		return nil, nil, fmt.Errorf("serialize proof: %w", err)
	}

	pw, err := witness.Public()
	if err != nil {
		return nil, nil, fmt.Errorf("extract public witness: %w", err)
	}
	var pwBuf bytes.Buffer
	if _, err := pw.WriteTo(&pwBuf); err != nil {
		return nil, nil, fmt.Errorf("serialize public witness: %w", err)
	}

	return proofBuf.Bytes(), pwBuf.Bytes(), nil
}

func promise(fn func() (js.Value, error)) js.Value {
	handler := js.FuncOf(func(_ js.Value, promiseArgs []js.Value) any {
		resolve := promiseArgs[0]
		reject := promiseArgs[1]
		go func() {
			value, err := fn()
			if err != nil {
				reject.Invoke(jsErrorObject("kakure prover: %v", err))
				return
			}
			resolve.Invoke(value)
		}()
		return nil
	})
	return js.Global().Get("Promise").New(handler)
}

func proofResult(proofBytes, pwBytes []byte) js.Value {
	proofArr := js.Global().Get("Uint8Array").New(len(proofBytes))
	js.CopyBytesToJS(proofArr, proofBytes)
	pwArr := js.Global().Get("Uint8Array").New(len(pwBytes))
	js.CopyBytesToJS(pwArr, pwBytes)
	result := js.Global().Get("Object").New()
	result.Set("proof", proofArr)
	result.Set("pw", pwArr)
	return result
}

func main() {
	js.Global().Set("kakureProve", js.FuncOf(prove))
	js.Global().Set("kakurePrepareCircuit", js.FuncOf(prepareCircuit))
	js.Global().Set("kakureProvePrepared", js.FuncOf(provePrepared))
	// Signal readiness to the host page/Node harness.
	js.Global().Set("kakureProveReady", true)
	// Keep the wasm program alive; syscall/js callbacks run on this goroutine's event loop.
	select {}
}
