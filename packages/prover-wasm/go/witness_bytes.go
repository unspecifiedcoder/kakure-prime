// Bytes-based re-implementations of Sunspot's file-based ACIR/witness loaders
// (~/sunspot/go/acir/witness.go's `LoadWitnessStackFromFile`/`(*ACIR).GetWitness`).
//
// WHY THIS FILE EXISTS: Sunspot's loaders take a file path (`os.Open`), which
// is unavailable in a browser's `GOOS=js GOARCH=wasm` sandbox (no real
// filesystem). Rather than fork or vendor Sunspot's `acir` package, this file
// reimplements just the two file-path-shaped functions against `[]byte`,
// calling ONLY the acir/shared/msgpackutil packages' already-exported
// building blocks (`msgpackutil.Reader`, `shr.Witness`, `acir.StackItem`,
// `acir.WitnessStack`, `acir.PublicWitnesses`, ...) -- every line below has a
// 1:1 counterpart in the upstream file, with `os.Open(path)` replaced by
// `gzip.NewReader(bytes.NewReader(data))`. If Sunspot's witness wire format
// ever changes, this file must be updated to match.
package main

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"math/big"

	"github.com/reilabs/sunspot/go/acir"
	"github.com/reilabs/sunspot/go/acir/msgpackutil"
	shr "github.com/reilabs/sunspot/go/acir/shared"
	"github.com/reilabs/sunspot/go/bn254"

	"github.com/consensys/gnark/backend/witness"
)

// loadWitnessStackFromBytes mirrors acir.LoadWitnessStackFromFile, reading the
// gzip'd msgpack witness stack from an in-memory buffer instead of a file.
func loadWitnessStackFromBytes[T shr.ACIRField](data []byte) (acir.WitnessStack[T], error) {
	gz, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return acir.WitnessStack[T]{}, fmt.Errorf("failed to create gzip reader: %w", err)
	}
	defer gz.Close()

	if err := msgpackutil.ConsumeFormatByte(gz); err != nil {
		return acir.WitnessStack[T]{}, fmt.Errorf("witness: %w", err)
	}
	r := msgpackutil.NewReader(gz)

	var stack acir.WitnessStack[T]
	err = msgpackutil.ReadStruct(r, "WitnessStack", []msgpackutil.Field{
		{Name: "stack", Decode: func(r *msgpackutil.Reader) error {
			n, err := r.ReadArrayLen()
			if err != nil {
				return err
			}
			stack = make(acir.WitnessStack[T], 0, n)
			for i := 0; i < n; i++ {
				item, err := readStackItemBytes[T](r)
				if err != nil {
					return fmt.Errorf("stack item %d: %w", i, err)
				}
				stack = append(stack, item)
			}
			return nil
		}},
	})
	if err != nil {
		return acir.WitnessStack[T]{}, err
	}
	return stack, nil
}

func readStackItemBytes[T shr.ACIRField](r *msgpackutil.Reader) (acir.StackItem[T], error) {
	var stackItem acir.StackItem[T]
	err := msgpackutil.ReadStruct(r, "StackItem", []msgpackutil.Field{
		{Name: "index", Decode: func(r *msgpackutil.Reader) error {
			v, err := r.ReadUint()
			if err != nil {
				return err
			}
			stackItem.CircuitIndex = uint32(v)
			return nil
		}},
		{Name: "witness", Decode: func(r *msgpackutil.Reader) error { return readWitnessMapBytes(r, &stackItem.WitnessMap) }},
	})
	return stackItem, err
}

func readWitnessMapBytes[T shr.ACIRField](r *msgpackutil.Reader, dst *map[shr.Witness]T) error {
	n, err := r.ReadMapLen()
	if err != nil {
		return err
	}
	*dst = make(map[shr.Witness]T, n)
	for i := 0; i < n; i++ {
		var w shr.Witness
		if err := w.UnmarshalReader(r); err != nil {
			return err
		}
		var value T
		value = shr.MakeNonNil(value)
		if err := value.UnmarshalReader(r); err != nil {
			return err
		}
		(*dst)[w] = value
	}
	return nil
}

// getWitnessFromBytes mirrors (*acir.ACIR).GetWitness, taking the witness.gz
// payload as an in-memory []byte instead of a file path. Specialized to this
// package's concrete ACIR type (T=*bn254.BN254Field, E=constraint.U64) to
// avoid re-deriving gnark's constraint.Element generic bound here.
func getWitnessFromBytes(loadedAcir *acirT, data []byte, field *big.Int) (witness.Witness, error) {
	witnessStack, err := loadWitnessStackFromBytes[*bn254.BN254Field](data)
	if err != nil {
		return nil, fmt.Errorf("failed to load witness stack: %w", err)
	}

	w, err := witness.New(field)
	if err != nil {
		return nil, fmt.Errorf("failed to create new witness: %w", err)
	}

	if len(witnessStack) == 0 {
		return nil, fmt.Errorf("witness stack is empty")
	}

	publicWitnesses := loadedAcir.PublicWitnesses()
	publicSlots := make(map[shr.Witness]struct{}, len(publicWitnesses))
	for _, pub := range publicWitnesses {
		publicSlots[pub.MainIndex] = struct{}{}
	}

	values := make(chan any)

	countPublic := len(publicWitnesses)
	countPrivate := 0
	for _, stackItem := range witnessStack {
		c := &loadedAcir.Program.Functions[stackItem.CircuitIndex]
		countPrivate += int(c.CurrentWitnessIndex) + 1
	}
	countPrivate -= countPublic

	go func() {
		outerStackItem := witnessStack[len(witnessStack)-1]
		for _, pub := range publicWitnesses {
			value, ok := outerStackItem.WitnessMap[pub.MainIndex]
			if !ok {
				values <- 0
				continue
			}
			values <- value.ToFrontendVariable()
		}
		for i := 0; i < len(witnessStack); i++ {
			stackItem := witnessStack[i]
			c := &loadedAcir.Program.Functions[stackItem.CircuitIndex]
			for j := uint32(0); j <= c.CurrentWitnessIndex; j++ {
				witnessKey := shr.Witness(j)
				if i == len(witnessStack)-1 {
					if _, isPublic := publicSlots[witnessKey]; isPublic {
						continue
					}
				}
				witnessValue, ok := stackItem.WitnessMap[witnessKey]
				if !ok {
					values <- 0
					continue
				}
				values <- witnessValue.ToFrontendVariable()
			}
		}
		close(values)
	}()

	if err := w.Fill(countPublic, countPrivate, values); err != nil {
		return nil, fmt.Errorf("failed to fill witness: %w", err)
	}
	return w, nil
}
